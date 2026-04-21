/**
 * teams-watcher.mjs - Persistent browser watcher for Teams push notifications.
 * 
 * Keeps a headed Edge browser open on the Teams Activity feed.
 * Monitors the sidebar unread badges for channel activity without
 * clicking channels (which would mark them as read).
 * 
 * Writes notification files that the bridge reads for instant detection.
 * 
 * Usage: node teams-watcher.mjs
 * Started automatically by start-agents.ps1.
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

async function main() {
  console.error("[watcher] Starting persistent Teams browser (Activity feed mode)...");

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "msedge",
    headless: false,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--window-size=400,600",
      "--window-position=9999,9999"
    ],
    viewport: { width: 400, height: 600 }
  });

  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(30000);

  console.error("[watcher] Navigating to Teams...");
  await page.goto("https://teams.cloud.microsoft", { waitUntil: "domcontentloaded" });

  try {
    await page.waitForSelector('nav[aria-label="Apps"]', { timeout: 30000 });
    console.error("[watcher] Teams loaded and authenticated.");
  } catch {
    console.error("[watcher] Waiting for manual auth (first run). Sign in in the browser window.");
    console.error("[watcher] TIP: Move the browser window from off-screen (it starts at 9999,9999).");
    await page.waitForSelector('nav[aria-label="Apps"]', { timeout: 120000 });
    console.error("[watcher] Auth complete. Moving window off-screen.");
  }

  // Build channel name lookup
  const channelNames = config.channels.map(c => c.name.toLowerCase());

  // Track what we've already notified about
  const notifiedActivity = new Set();

  console.error("[watcher] Monitoring sidebar unread badges. Not clicking channels (preserves unread state).");

  while (true) {
    try {
      // Read the sidebar for unread indicators without clicking anything
      // Teams sidebar shows channel names with "Unread" badges
      const unreadChannels = await page.evaluate((names) => {
        const results = [];
        // Look for tree items with "Unread" in their accessible name
        const items = document.querySelectorAll('[role="treeitem"]');
        for (const item of items) {
          const label = (item.getAttribute("aria-label") || item.textContent || "").toLowerCase();
          if (!label.includes("unread")) continue;
          // Check if this matches one of our channel names
          for (const name of names) {
            if (label.includes(name)) {
              results.push(name);
              break;
            }
          }
        }
        return results;
      }, channelNames);

      for (const channelLower of unreadChannels) {
        const channel = config.channels.find(c => c.name.toLowerCase() === channelLower);
        if (!channel) continue;

        // Create a unique key for this detection (channel + minute to debounce)
        const key = `${channel.name}-${Math.floor(Date.now() / 60000)}`;
        if (notifiedActivity.has(key)) continue;
        notifiedActivity.add(key);

        // Bound the set
        if (notifiedActivity.size > 200) {
          const arr = [...notifiedActivity];
          notifiedActivity.clear();
          arr.slice(-100).forEach(k => notifiedActivity.add(k));
        }

        console.error(`[watcher] Unread detected: ${channel.name}`);
        writeFileSync(notifyFile(channel.name), JSON.stringify({
          channel: channel.name,
          detectedAt: new Date().toISOString(),
          source: "sidebar-badge"
        }));
      }
    } catch (e) {
      console.error(`[watcher] Scan error: ${e.message}`);
    }

    // Check every 2 seconds (lightweight DOM read, no navigation)
    await page.waitForTimeout(2000);
  }
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

main().catch(e => {
  console.error(`[watcher] Fatal: ${e.message}`);
  process.exit(1);
});
