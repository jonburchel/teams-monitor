/**
 * teams-watcher.mjs - True push detection via MutationObserver.
 * 
 * Opens Teams in a persistent Edge browser with one tab per channel.
 * Injects a MutationObserver into each tab that fires a callback
 * into Node.js the instant a new message DOM node appears.
 * Writes notification files that the bridge reads for instant polling.
 * 
 * NO POLLING. The browser pushes to us.
 */

import { chromium } from "playwright";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CONFIG_PATH = join(ROOT, "workflow.config.json");
const NOTIFY_DIR = join(ROOT, ".agents", "state", "notifications");
const PROFILE_DIR = join(ROOT, ".agents", "state", "browser-profile");

if (!existsSync(NOTIFY_DIR)) mkdirSync(NOTIFY_DIR, { recursive: true });
if (!existsSync(PROFILE_DIR)) mkdirSync(PROFILE_DIR, { recursive: true });

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

function notifyFile(channelName) {
  return join(NOTIFY_DIR, `${channelName.replace(/[^a-zA-Z0-9]/g, '_')}.notify`);
}

async function setupChannelTab(context, channel, teamId) {
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  // Expose a function the browser can call to notify us
  await page.exposeFunction('__teamsMonitorNotify', (channelName) => {
    console.error(`[watcher] PUSH: New activity in ${channelName}`);
    writeFileSync(notifyFile(channelName), JSON.stringify({
      channel: channelName,
      detectedAt: new Date().toISOString(),
      source: "mutation-observer"
    }));
  });

  // Navigate to Teams
  console.error(`[watcher] Opening tab for ${channel.name}...`);
  await page.goto("https://teams.cloud.microsoft", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(8000);

  // Wait for Teams to load
  try {
    await page.waitForSelector('nav[aria-label="Apps"]', { timeout: 30000 });
  } catch {
    console.error(`[watcher] ${channel.name}: Waiting for auth (first run). Sign in manually.`);
    await page.waitForSelector('nav[aria-label="Apps"]', { timeout: 120000 });
  }

  // Navigate to the channel via sidebar
  try {
    const myAgents = page.getByRole("treeitem", { name: config.team || "My Agents" });
    await myAgents.click();
    await page.waitForTimeout(2000);

    // Look for the channel name in the expanded tree
    const channelEl = page.getByText(channel.name, { exact: true }).first();
    await channelEl.click();
    await page.waitForTimeout(3000);

    // Verify we're on the right channel
    const title = await page.title();
    console.error(`[watcher] ${channel.name}: On page "${title}"`);
  } catch (e) {
    console.error(`[watcher] ${channel.name}: Navigation failed: ${e.message}. Tab will retry on reload.`);
  }

  // Inject MutationObserver that watches for new message nodes
  const channelName = channel.name;
  await page.evaluate((chName) => {
    // Find the message container (Teams uses various structures)
    function findMessageContainer() {
      // Try common Teams message list selectors
      const candidates = [
        document.querySelector('[data-tid="message-pane-list-items"]'),
        document.querySelector('[role="main"] [role="list"]'),
        document.querySelector('[data-tid="chat-pane-message"]')?.parentElement,
        // Fallback: the largest scrollable div in the main content area
        ...Array.from(document.querySelectorAll('[role="main"] div')).filter(el => el.scrollHeight > el.clientHeight && el.children.length > 3)
      ];
      return candidates.find(el => el) || document.querySelector('[role="main"]');
    }

    let container = findMessageContainer();
    let debounceTimer = null;

    function startObserving(target) {
      if (!target) return;
      const observer = new MutationObserver((mutations) => {
        // Debounce: multiple mutations fire at once when a message arrives
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          // Check if any added nodes look like messages (not just UI chrome)
          for (const m of mutations) {
            for (const node of m.addedNodes) {
              if (node.nodeType === 1 && node.textContent && node.textContent.trim().length > 5) {
                window.__teamsMonitorNotify(chName);
                return;
              }
            }
          }
        }, 500); // 500ms debounce to batch rapid mutations
      });

      observer.observe(target, { childList: true, subtree: true });
      console.log(`[teams-watcher] MutationObserver active for ${chName} on`, target.tagName, target.className?.slice(0, 50));
    }

    startObserving(container);

    // Re-find container periodically in case Teams rebuilds the DOM
    setInterval(() => {
      const newContainer = findMessageContainer();
      if (newContainer && newContainer !== container) {
        console.log(`[teams-watcher] Container changed for ${chName}, re-attaching observer`);
        container = newContainer;
        startObserving(container);
      }
    }, 10000);
  }, channelName);

  console.error(`[watcher] ${channel.name}: MutationObserver injected. Listening for push events.`);
  return page;
}

async function main() {
  console.error("[watcher] Starting Teams browser with MutationObserver push detection...");

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "msedge",
    headless: false,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--window-size=400,300",
      "--window-position=9999,9999"
    ],
    viewport: { width: 400, height: 300 }
  });

  // Close the default blank tab
  const defaultPage = context.pages()[0];

  const pages = [];
  for (const channel of config.channels) {
    try {
      const page = await setupChannelTab(context, channel, config.teamId);
      pages.push({ channel: channel.name, page });
    } catch (e) {
      console.error(`[watcher] Failed to set up ${channel.name}: ${e.message}`);
    }
  }

  // Close the original blank tab
  if (defaultPage && defaultPage !== pages[0]?.page) {
    try { await defaultPage.close(); } catch {}
  }

  console.error(`[watcher] All ${pages.length} channels active. Waiting for push events (no polling).`);

  // Keep alive + handle page crashes
  while (true) {
    await new Promise(r => setTimeout(r, 30000));

    for (const p of pages) {
      try {
        if (p.page.isClosed()) {
          console.error(`[watcher] ${p.channel} tab closed. Reopening...`);
          const ch = config.channels.find(c => c.name === p.channel);
          if (ch) p.page = await setupChannelTab(context, ch, config.teamId);
        }
      } catch (e) {
        console.error(`[watcher] ${p.channel} health check error: ${e.message}`);
      }
    }
  }
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

main().catch(e => {
  console.error(`[watcher] Fatal: ${e.message}`);
  process.exit(1);
});
