/**
 * Teams Bridge MCP Server
 * 
 * A per-channel MCP server that runs as stdio transport for a Copilot session.
 * 
 * Usage: node index.mjs --channel "Fabric Docs" [--mcp-port 58410]
 * 
 * Each Copilot session gets its own instance filtered to one channel.
 * All instances share:
 *   - The same Teams MCP HTTP proxy (started by the first instance, or externally)
 *   - The same last-seen.json for deduplication
 *   - The same background-tasks.json for scheduling
 * 
 * Tools exposed:
 *   check_messages()      - Returns new messages for THIS channel only
 *   send_reply(...)       - Posts a reply via Teams MCP with Adaptive Card
 *   check_background_tasks() - Returns due scheduled tasks
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let ServiceBusClient;
try {
  const sb = await import("@azure/service-bus");
  ServiceBusClient = sb.ServiceBusClient;
} catch { /* Service Bus not installed, will use Graph API polling fallback */ }

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CONFIG_PATH = join(ROOT, "workflow.config.json");
const LAST_SEEN_PATH = join(ROOT, ".agents", "state", "last-seen.json");
const BG_TASKS_PATH = join(ROOT, "background-tasks.json");
const SB_CONN_FILE = join(ROOT, ".agents", "state", "servicebus-connection.txt");
const STATE_DIR = join(ROOT, ".agents", "state");

// Parse args
const args = process.argv.slice(2);
let channelFilter = null;
let mcpPort = 58410;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--channel" && args[i+1]) { channelFilter = args[++i]; }
  if (args[i] === "--mcp-port" && args[i+1]) { mcpPort = parseInt(args[++i]); }
}

// --- State ---
let config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
const myChannel = channelFilter
  ? config.channels.find(c => c.name.toLowerCase() === channelFilter.toLowerCase())
  : null;

if (channelFilter && !myChannel) {
  console.error(`[teams-bridge] Channel "${channelFilter}" not found in config. Available: ${config.channels.map(c => c.name).join(", ")}`);
  process.exit(1);
}

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

// Per-channel last-seen files to avoid cross-instance race conditions
function loadChannelLastSeen(channelId) {
  const file = join(STATE_DIR, `last-seen-${channelId.replace(/[^a-zA-Z0-9]/g, '_')}.txt`);
  try { return readFileSync(file, "utf-8").trim(); } catch { return null; }
}
function saveChannelLastSeen(channelId, timestamp) {
  const file = join(STATE_DIR, `last-seen-${channelId.replace(/[^a-zA-Z0-9]/g, '_')}.txt`);
  try { writeFileSync(file, timestamp); } catch {}
}

let mcpInitialized = false;
let mcpRequestId = 0;
let messageQueue = []; // messages for our channel, pending consumption
let pendingLastSeen = []; // timestamps to persist AFTER consumer reads them
let bgTaskSchedule = {}; // taskId -> nextDueAt (wall clock)
let pollTimer = null;
let seenIds = new Set(); // dedup by message ID
let activeThreads = new Map(); // root message ID -> { channelId, channelName, lastActivity: ISO timestamp }
let sbReceiver = null; // Service Bus receiver (if configured)
let usePushMode = false; // true when Service Bus is active

const label = myChannel ? `[${myChannel.name}]` : "[all]";

// Push mode: 500ms queue check. Fallback: 5s Graph API poll.
const POLL_INTERVAL_PUSH = 500;
const POLL_INTERVAL_FALLBACK = 5000;

// --- Service Bus setup ---

async function initServiceBus() {
  if (!ServiceBusClient) return false;
  
  let connStr;
  try {
    connStr = readFileSync(SB_CONN_FILE, "utf-8").trim();
  } catch {
    console.error(`${label} No Service Bus connection string at ${SB_CONN_FILE}. Using Graph API polling.`);
    return false;
  }

  try {
    const client = new ServiceBusClient(connStr);
    sbReceiver = client.createReceiver("teams-messages", { receiveMode: "receiveAndDelete" });
    console.error(`${label} Service Bus connected. Push mode active.`);
    return true;
  } catch (e) {
    console.error(`${label} Service Bus init failed: ${e.message}. Using Graph API polling.`);
    return false;
  }
}

// Check Service Bus queue for push notifications from Azure Function
async function checkServiceBus() {
  if (!sbReceiver) return [];

  try {
    const messages = await sbReceiver.receiveMessages(10, { maxWaitTimeInMs: 200 });
    return messages
      .filter(m => m.body?.type === "message")
      .filter(m => {
        // Filter to our channel if we have one
        if (!myChannel) return true;
        return m.body.channelId === myChannel.channelId;
      })
      .map(m => m.body);
  } catch (e) {
    console.error(`${label} Service Bus receive error: ${e.message}`);
    return [];
  }
}

// --- Teams MCP HTTP proxy ---

// The Teams MCP proxy is started externally by start-agents.ps1.
// We just connect to it.

async function mcpCall(method, params, timeoutMs = 45000) {
  const myId = ++mcpRequestId;
  const isNotification = method.startsWith("notifications/");
  const envelope = isNotification
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", method, id: myId, params };
  const body = JSON.stringify(envelope);

  const resp = await fetch(`http://localhost:${mcpPort}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
    body,
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (isNotification) return; // notifications have no response

  if (!resp.ok) {
    const errText = (await resp.text()).slice(0, 200);
    throw new Error(`HTTP ${resp.status}: ${errText}`);
  }

  const text = await resp.text();

  // Try SSE format first, fall back to plain JSON
  const lines = text.split("\n").filter(l => l.startsWith("data: ")).map(l => l.slice(6));
  let results = lines.filter(l => l.trim()).map(l => JSON.parse(l));

  if (results.length === 0) {
    // Plain JSON response (not SSE)
    try { results = [JSON.parse(text)]; } catch { throw new Error(`Bad MCP response: ${text.slice(0, 200)}`); }
  }

  // Pick the response matching our request ID
  const env = results.find(r => r.id === myId) ?? results.at(-1);

  // Check for JSON-RPC errors
  if (env?.error) throw new Error(`MCP error ${env.error.code}: ${env.error.message}`);

  return env;
}

async function mcpToolCall(name, args) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const env = await mcpCall("tools/call", { name, arguments: args }, 90000);
      if (env?.result?.isError) throw new Error(`Tool error: ${JSON.stringify(env.result.content)}`);
      return env;
    } catch (e) {
      if (attempt === 0) {
        console.error(`${label} ${name} attempt 1 failed: ${e.message}. Retrying...`);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        throw e;
      }
    }
  }
}

async function initMcp() {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      await mcpCall("initialize", {
        capabilities: {},
        clientInfo: { name: `teams-bridge-${myChannel?.agent || "all"}`, version: "1.0" },
        protocolVersion: "2025-06-18"
      });
      // Send required initialized notification
      await mcpCall("notifications/initialized", {});
      mcpInitialized = true;
      console.error(`${label} Teams MCP ready on port ${mcpPort}${attempt > 1 ? ` (after ${attempt} attempts)` : ""}`);

      return;
    } catch (e) {
      if (attempt <= 3 || attempt % 10 === 0) {
        console.error(`${label} Init attempt ${attempt}: ${e.message}. Retrying...`);
      }
      await new Promise(r => setTimeout(r, Math.min(3000 + attempt * 1000, 10000)));
    }
  }
}

// --- Polling ---

function stripHtml(html) { return (html || "").replace(/<[^>]+>/g, "").replace(/[\u200B\u200C\u200D\uFEFF]/g, "").trim(); }

// Identify own replies by checking for bot markers in the raw HTML/card content
// Uses structural markers (Adaptive Card JSON, HTML strong tag) not loose substring matches
function isOwnReply(body) {
  if (!body) return false;
  // Adaptive Card signature (structural, not spoofable by plaintext)
  if (body.includes('"type":"AdaptiveCard"') || body.includes('"type": "AdaptiveCard"')) return true;
  // Our HTML bold prefix (only matches the exact strong tag format we produce)
  if (body.includes('<strong>🤖 Copilot:</strong>')) return true;
  // Dormant thread closing message marker
  if (body.startsWith('Teams Monitor:')) return true;
  return false;
}

async function poll() {
  if (!mcpInitialized) return;

  // In push mode, check Service Bus first for instant notifications
  if (usePushMode) {
    const sbMessages = await checkServiceBus();
    for (const sbMsg of sbMessages) {
      if (seenIds.has(sbMsg.messageId)) continue;
      seenIds.add(sbMsg.messageId);

      // We got a notification that a new message exists. Fetch it via Graph API.
      const channel = config.channels.find(c => c.channelId === sbMsg.channelId) || myChannel;
      if (!channel) continue;

      try {
        const result = await mcpToolCall("ListChannelMessages", {
          teamId: config.teamId,
          channelId: channel.channelId
        });
        const textContent = result?.result?.content?.find(c => c.type === "text")?.text;
        if (textContent) {
          const messages = JSON.parse(textContent).messages || [];
          const msg = messages.find(m => m.id === sbMsg.messageId);
          if (msg && msg.from) {
            const bodyText = msg.body?.content || "";
            const stripped = stripHtml(bodyText);
            if (stripped && !isOwnReply(bodyText)) {
              messageQueue.push({
                channel: channel.name, channelId: channel.channelId,
                workDir: channel.workingDirectory, secondaryDir: channel.secondaryDirectory || null,
                messageId: msg.id, from: msg.from?.user?.displayName || "Unknown",
                text: stripped, createdAt: msg.createdDateTime
              });
              pendingLastSeen.push({ channelId: channel.channelId, timestamp: msg.createdDateTime });
              console.error(`${label} PUSH: ${msg.from?.user?.displayName}: ${stripped.slice(0, 60)}`);
            }
          }
        }
      } catch (e) {
        console.error(`${label} Push fetch error: ${e.message}`);
      }
    }
    // In push mode, still do a full poll every 30s as fallback (not every cycle)
    if (Date.now() % 30000 > 1000) return;
  }

  // Fallback: full Graph API poll (runs every cycle in fallback mode, every ~30s in push mode)
  const channelsToPoll = myChannel ? [myChannel] : config.channels;
  const hardCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  for (const channel of channelsToPoll) {
    try {
      const result = await mcpToolCall("ListChannelMessages", {
        teamId: config.teamId,
        channelId: channel.channelId
      });

      const textContent = result?.result?.content?.find(c => c.type === "text")?.text;
      if (!textContent) continue;

      let messages;
      try { messages = JSON.parse(textContent).messages || []; } catch { continue; }

      const channelLastSeen = loadChannelLastSeen(channel.channelId);
      // Don't hard-filter by 10min if we have a cursor (handles outage recovery)
      const effectiveCutoff = channelLastSeen || hardCutoff;

      for (const msg of messages) {
        if (!msg.createdDateTime) continue;
        if (!msg.from) continue;

        const bodyText = msg.body?.content || "";
        const stripped = stripHtml(bodyText);

        // Skip our own messages entirely (don't track as active threads either)
        if (isOwnReply(bodyText)) {
          seenIds.add(msg.id);
          continue;
        }

        if (msg.createdDateTime <= effectiveCutoff) continue;
        if (!stripped) continue;

        // Deduplicate by message ID
        if (seenIds.has(msg.id)) continue;
        if (messageQueue.find(m => m.messageId === msg.id)) continue;

        seenIds.add(msg.id);
        if (seenIds.size > 500) {
          const arr = [...seenIds];
          seenIds = new Set(arr.slice(-250));
        }

        messageQueue.push({
          channel: channel.name,
          channelId: channel.channelId,
          workDir: channel.workingDirectory,
          secondaryDir: channel.secondaryDirectory || null,
          messageId: msg.id,
          from: msg.from?.user?.displayName || msg.from?.displayName || "Unknown",
          text: stripped,
          createdAt: msg.createdDateTime
        });

        // Queue for persistence AFTER consumer reads
        pendingLastSeen.push({ channelId: channel.channelId, timestamp: msg.createdDateTime });

        console.error(`${label} NEW: ${msg.from?.user?.displayName}: ${stripped.slice(0, 60)}`);
      }

      // --- Scan replies in active threads (only for this channel) ---
      const THREAD_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
      const now = Date.now();

      for (const [threadId, threadInfo] of activeThreads) {
        if (threadInfo.channelId !== channel.channelId) continue;

        // Check if thread is expired (24h since last activity)
        const lastAct = new Date(threadInfo.lastActivity).getTime();
        if (now - lastAct > THREAD_TTL_MS) {
          // Post a closing note (no self-DM)
          try {
            await mcpToolCall("ReplyToChannelMessage", {
              teamId: config.teamId,
              channelId: threadInfo.channelId,
              messageId: threadId,
              content: "Teams Monitor: This thread has been inactive for 24 hours. I'm no longer monitoring it. To continue, please start a new message in the channel and I'll pick it up.",
              contentType: "text"
            });
            console.error(`${label} Closed dormant thread ${threadId}`);
          } catch {}
          activeThreads.delete(threadId);
          continue;
        }

        try {
          const replyResult = await mcpToolCall("ListChannelMessageReplies", {
            teamId: config.teamId,
            channelId: channel.channelId,
            messageId: threadId,
            maxReplies: 10
          });

          const replyText = replyResult?.result?.content?.find(c => c.type === "text")?.text;
          if (!replyText) continue;

          let replies;
          try { replies = JSON.parse(replyText).replies || []; } catch { continue; }

          for (const reply of replies) {
            if (!reply.createdDateTime || !reply.from) continue;
            const replyBody = reply.body?.content || "";
            const replyStripped = stripHtml(replyBody);
            if (!replyStripped || isOwnReply(replyBody)) continue;
            if (seenIds.has(reply.id)) continue;

            seenIds.add(reply.id);

            // Update thread last activity
            threadInfo.lastActivity = reply.createdDateTime;

            messageQueue.push({
              channel: channel.name,
              channelId: channel.channelId,
              workDir: channel.workingDirectory,
              secondaryDir: channel.secondaryDirectory || null,
              messageId: threadId,
              from: reply.from?.user?.displayName || reply.from?.displayName || "Unknown",
              text: replyStripped,
              createdAt: reply.createdDateTime,
              isThreadReply: true
            });

            // Don't push to pendingLastSeen - reply timestamps must not advance the root-message cursor
            console.error(`${label} REPLY: ${reply.from?.user?.displayName || "Unknown"}: ${replyStripped.slice(0, 60)}`);
          }
        } catch (e) {
          if (e.message?.includes("404") || e.message?.includes("Not Found")) {
            activeThreads.delete(threadId);
          }
        }
      }
    } catch (e) {
      console.error(`${label} Poll error: ${e.message}`);
    }
  }
}

// --- MCP Server ---

const server = new McpServer({ name: "teams-bridge", version: "1.0.0" });

server.tool(
  "check_messages",
  "Check for new messages in your monitored Teams channel. Returns pending messages or empty if quiet. Call this repeatedly in a loop.",
  {},
  async () => {
    const msgs = [...messageQueue];
    messageQueue.length = 0;

    // NOW persist last-seen cursors (only after consumer has the messages)
    for (const p of pendingLastSeen) {
      const current = loadChannelLastSeen(p.channelId);
      if (!current || p.timestamp > current) {
        saveChannelLastSeen(p.channelId, p.timestamp);
      }
    }
    pendingLastSeen.length = 0;

    return { content: [{ type: "text", text: JSON.stringify({
      newMessages: msgs.map(m => ({
        channel: m.channel, channelId: m.channelId, workDir: m.workDir,
        secondaryDir: m.secondaryDir, messageId: m.messageId,
        from: m.from, text: m.text, createdAt: m.createdAt
      })),
      status: msgs.length ? "has_messages" : "quiet"
    })}]};
  }
);

server.tool(
  "send_reply",
  "Reply IN-THREAD to a specific Teams message. Posts an Adaptive Card reply, marks thread unread, and sends a self-DM. This is the ONLY tool for responding to user messages. NEVER use post_channel_message for responses.",
  {
    channelId: z.string().describe("Channel ID"),
    messageId: z.string().describe("Message ID to reply to"),
    channelName: z.string().describe("Channel name"),
    replyText: z.string().describe("Reply content (plain text)")
  },
  async ({ channelId, messageId, channelName, replyText }) => {
    try {
      const cardJson = JSON.stringify({
        type: "AdaptiveCard", version: "1.4",
        body: [
          { type: "ColumnSet", columns: [
            { type: "Column", width: "auto", items: [{ type: "Image", url: "https://img.icons8.com/fluency/48/robot-2.png", size: "Small" }] },
            { type: "Column", width: "stretch", items: [
              { type: "TextBlock", text: "Teams Monitor", weight: "Bolder", size: "Medium" },
              { type: "TextBlock", text: channelName, isSubtle: true, spacing: "None", size: "Small" }
            ]}
          ]},
          { type: "TextBlock", text: replyText, wrap: true }
        ]
      });

      await mcpToolCall("ReplyToChannelMessage", {
        teamId: config.teamId, channelId, messageId,
        content: "​",
        contentType: "html",
        adaptiveCardJson: cardJson
      });

      // Track this thread for follow-up reply scanning
      activeThreads.set(messageId, {
        channelId, channelName,
        lastActivity: new Date().toISOString()
      });

      // Fire-and-forget: send self-DM notification
      setTimeout(async () => {
        try {
          await mcpToolCall("SendMessageToSelf", {
            content: `[Teams Monitor] ${channelName}: ${replyText.slice(0, 80)}...`
          });
          console.error(`${label} Self-DM sent`);
        } catch (e) {
          console.error(`${label} Self-DM failed: ${e.message}`);
        }
      }, 500);

      return{ content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, error: e.message }) }] };
    }
  }
);

server.tool(
  "post_channel_message",
  "Post a new TOP-LEVEL message (NOT a reply). ONLY use this for the startup hello announcement. NEVER use this to respond to a user message; use send_reply instead.",
  {
    channelId: z.string().describe("Channel ID"),
    channelName: z.string().describe("Channel name"),
    messageText: z.string().describe("Message content (plain text)")
  },
  async ({ channelId, channelName, messageText }) => {
    try {
      const cardJson = JSON.stringify({
        type: "AdaptiveCard", version: "1.4",
        body: [
          { type: "Container", style: "good", bleed: true, items: [
            { type: "ColumnSet", columns: [
              { type: "Column", width: "auto", verticalContentAlignment: "Center",
                items: [{ type: "Image", url: "https://img.icons8.com/fluency/48/robot-2.png", size: "Small" }] },
              { type: "Column", width: "stretch", items: [
                { type: "TextBlock", text: "Teams Monitor", weight: "Bolder", size: "Medium" },
                { type: "TextBlock", text: `🟢 Online — ${channelName}`, isSubtle: true, spacing: "None", size: "Small" }
              ]}
            ]}
          ]},
          { type: "TextBlock", text: messageText, wrap: true, spacing: "Medium" }
        ]
      });

      await mcpToolCall("PostChannelMessage", {
        teamId: config.teamId, channelId,
        content: "\u200B",
        contentType: "html",
        adaptiveCardJson: cardJson
      });

      return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, error: e.message }) }] };
    }
  }
);

server.tool(
  "check_background_tasks",
  "Check if any background tasks are due. Returns task prompts or empty.",
  {},
  async () => {
    // Only the Home agent should run background tasks (avoid 3x execution)
    if (myChannel && myChannel.agent !== "home") {
      return { content: [{ type: "text", text: '{"tasks":[]}' }] };
    }
    if (!existsSync(BG_TASKS_PATH)) return { content: [{ type: "text", text: '{"tasks":[]}' }] };
    const tasksConfig = JSON.parse(readFileSync(BG_TASKS_PATH, "utf-8"));
    const due = [];
    const now = Date.now();
    for (const task of tasksConfig.tasks) {
      if (task.enabled === false) continue;
      // Wall-clock scheduling: intervalScans * POLL_INTERVAL as milliseconds
      const intervalMs = (task.intervalScans || 20) * (usePushMode ? POLL_INTERVAL_PUSH : POLL_INTERVAL_FALLBACK);
      if (!bgTaskSchedule[task.id]) bgTaskSchedule[task.id] = now + intervalMs;
      if (now >= bgTaskSchedule[task.id]) {
        due.push({ id: task.id, description: task.description, prompt: task.prompt });
        bgTaskSchedule[task.id] = now + intervalMs;
      }
    }
    return { content: [{ type: "text", text: JSON.stringify({ tasks: due }) }] };
  }
);

// --- Main ---

function schedulePoll() {
  const interval = usePushMode ? POLL_INTERVAL_PUSH : POLL_INTERVAL_FALLBACK;
  pollTimer = setTimeout(async () => {
    await poll();
    schedulePoll();
  }, interval);
}

async function main() {
  console.error(`${label} Starting Teams Bridge MCP (proxy at port ${mcpPort})...`);

  try {
    await initMcp();
  } catch (e) {
    console.error(`${label} FATAL: ${e.message}`);
    process.exit(1);
  }

  // Try Service Bus for push mode, fall back to Graph API polling
  usePushMode = await initServiceBus();
  if (usePushMode) {
    console.error(`${label} PUSH MODE: Service Bus queue + 500ms check. Sub-second detection.`);
  } else {
    console.error(`${label} FALLBACK MODE: Graph API polling every 5s.`);
  }

  await poll(); // initial
  schedulePoll();

  const activeInterval = usePushMode ? POLL_INTERVAL_PUSH : POLL_INTERVAL_FALLBACK;
  console.error(`${label} Ready. Polling every ${activeInterval/1000}s.`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
function cleanup() {
  clearTimeout(pollTimer);
}

main().catch(e => { console.error(`${label} Fatal: ${e.message}`); process.exit(1); });
