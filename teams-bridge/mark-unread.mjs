/**
 * mark-unread.mjs - Standalone Playwright script to mark a Teams message as unread.
 * 
 * Usage: node mark-unread.mjs <channelName> <messagePreview>
 * 
 * Connects to Edge via CDP, navigates to the channel, right-clicks the message,
 * and clicks "Mark as unread". Fast, no LLM tokens needed.
 */

import { chromium } from "playwright";

const channelName = process.argv[2];
const messagePreview = process.argv[3];

if (!channelName) {
  console.error("Usage: node mark-unread.mjs <channelName> [messagePreview]");
  process.exit(1);
}

const TEAMS_URL = "https://teams.cloud.microsoft";
const TIMEOUT = 30000;

async function run() {
  // Launch Edge with user profile for auth
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"]
  });

  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    // Navigate to Teams
    await page.goto(TEAMS_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(8000); // Teams SPA takes a while

    // Wait for Teams to fully load (look for the app nav)
    await page.waitForSelector('nav[aria-label="Apps"]', { timeout: 20000 });
    console.error("[mark-unread] Teams loaded");

    // Click "My Agents" in the sidebar to navigate to the team
    const myAgents = page.getByRole("treeitem", { name: "My Agents" });
    await myAgents.click();
    await page.waitForTimeout(3000);

    // Find and click the channel
    // The channel might be a sub-item under My Agents, or we might already be on it
    const channelHeading = page.getByRole("heading", { name: channelName, level: 2 });
    try {
      await channelHeading.waitFor({ timeout: 5000 });
      console.error(`[mark-unread] Already on ${channelName}`);
    } catch {
      // Try clicking the channel in sidebar
      const channelItem = page.getByText(channelName).first();
      await channelItem.click();
      await page.waitForTimeout(3000);
    }

    // Find the message to mark unread
    // If messagePreview is provided, find that specific message
    // Otherwise, find the last message in the thread
    let messageEl;
    if (messagePreview) {
      messageEl = page.getByText(messagePreview.slice(0, 40)).first();
    } else {
      // Find the last message element
      const messages = page.locator('[data-tid="chat-pane-message"]');
      messageEl = messages.last();
    }

    // Right-click the message
    await messageEl.click({ button: "right" });
    await page.waitForTimeout(1000);

    // Click "Mark as unread" in the context menu
    const markUnread = page.getByRole("menuitem", { name: "Mark as unread" });
    await markUnread.click();
    console.error(`[mark-unread] Marked as unread in ${channelName}`);

  } catch (e) {
    console.error(`[mark-unread] Error: ${e.message}`);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

run().catch(e => {
  console.error(`[mark-unread] Fatal: ${e.message}`);
  process.exit(1);
});
