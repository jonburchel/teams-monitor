/**
 * teams-actions.mjs - Deterministic Teams browser automation.
 *
 * Provides a persistent browser instance and pre-researched, deterministic
 * functions for Teams interactions. No LLM involvement needed.
 *
 * Exported functions:
 *   initBrowser()        - Launch/reuse persistent Edge browser with Teams
 *   markThreadUnread()   - Navigate to channel, right-click message, mark unread
 *   closeBrowser()       - Shut down the browser
 *
 * DOM selectors were validated against Teams Web on 2026-04-21.
 * Self-healing: if primary selectors fail, alternatives are tried.
 * On total failure, returns error status without crashing.
 */

import { chromium } from "playwright";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, writeFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEAMS_BASE = "https://teams.cloud.microsoft";
const PROFILE_DIR = join(__dirname, "..", ".agents", "state", "browser-profile");
const SCREENSHOTS_DIR = join(__dirname, "..", ".agents", "state", "screenshots");
const label = "[teams-actions]";

let browser = null;
let page = null;
let currentChannelId = null;

// --- Browser lifecycle ---

export async function initBrowser() {
  if (browser && page) {
    try {
      await page.title(); // check if still alive
      return { success: true, reused: true };
    } catch {
      browser = null;
      page = null;
    }
  }

  try {
    mkdirSync(PROFILE_DIR, { recursive: true });
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    // Persistent context shares cookies/auth across sessions
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: "msedge",
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-notifications",
        "--window-position=-2000,-2000"
      ],
      viewport: { width: 1400, height: 900 },
      ignoreDefaultArgs: ["--enable-automation"]
    });

    page = context.pages()[0] || await context.newPage();
    browser = context;
    page.setDefaultTimeout(15000);

    // Navigate to Teams once
    await page.goto(TEAMS_BASE, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6000);

    console.error(`${label} Browser initialized.`);
    return { success: true, reused: false };
  } catch (e) {
    console.error(`${label} Browser init failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

export async function closeBrowser() {
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
    page = null;
    currentChannelId = null;
  }
}

// --- Core actions ---

/**
 * Navigate to a specific channel and mark the most recent thread as unread.
 *
 * @param {string} channelId - Teams channel ID (19:xxx@thread.tacv2)
 * @param {string} teamId - Team group ID (GUID)
 * @param {string} channelName - Human-readable channel name (for logging)
 * @param {string} [messageText] - Optional: text substring to find specific message
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function markThreadUnread(channelId, teamId, channelName, messageText) {
  const t0 = Date.now();
  try {
    // Step 0: ensure browser is alive
    const init = await initBrowser();
    if (!init.success) return { success: false, error: `Browser: ${init.error}` };

    // Step 1: navigate to channel (only if not already there)
    if (currentChannelId !== channelId) {
      const channelUrl = `${TEAMS_BASE}/v2/#/l/channel/${encodeURIComponent(channelId)}/conversations?groupId=${teamId}`;
      await page.goto(channelUrl, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(4000);
      currentChannelId = channelId;
    }

    // Step 2: wait for message elements to appear
    try {
      await page.waitForSelector("[data-mid]", { timeout: 10000 });
    } catch {
      return { success: false, error: "No messages found in channel" };
    }

    // Step 3: find the target message
    let targetMid = null;
    if (messageText) {
      // Find by text content
      targetMid = await page.evaluate((text) => {
        const mids = document.querySelectorAll("[data-mid]");
        for (const m of [...mids].reverse()) {
          if (m.textContent?.includes(text)) return m.getAttribute("data-mid");
        }
        return null;
      }, messageText.slice(0, 60));
    }
    if (!targetMid) {
      // Fall back to last message
      targetMid = await page.evaluate(() => {
        const mids = document.querySelectorAll("[data-mid]");
        return mids.length ? [...mids].at(-1).getAttribute("data-mid") : null;
      });
    }
    if (!targetMid) return { success: false, error: "No message element found" };

    // Step 4: right-click the message wrapper
    // Primary selector: walk up from [data-mid] to the wrapper div
    const rightClicked = await page.evaluate((mid) => {
      const msg = document.querySelector(`[data-mid="${mid}"]`);
      if (!msg) return false;
      let target = msg;
      // Walk up to find the thread/message wrapper (class pattern: ___1ncave0 or ___1lqv440)
      for (let i = 0; i < 8; i++) {
        target = target.parentElement;
        if (!target) break;
        const cls = target.className || "";
        if (cls.includes("1ncave0") || cls.includes("1lqv440")) {
          // Dispatch native right-click (contextmenu event)
          const rect = target.getBoundingClientRect();
          const evt = new MouseEvent("contextmenu", {
            bubbles: true, cancelable: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
            button: 2
          });
          target.dispatchEvent(evt);
          return true;
        }
      }
      // Fallback: right-click the message body itself
      const rect = msg.getBoundingClientRect();
      const evt = new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 2
      });
      msg.dispatchEvent(evt);
      return true;
    }, targetMid);

    if (!rightClicked) return { success: false, error: "Failed to right-click message" };

    await page.waitForTimeout(800);

    // Step 5: find and click "Mark as unread" in context menu
    // Primary: role=menuitem with exact text
    const clicked = await page.evaluate(() => {
      const items = document.querySelectorAll('[role="menuitem"]');
      for (const item of items) {
        const text = item.textContent?.trim();
        if (text === "Mark as unread") {
          item.click();
          return { success: true };
        }
      }
      // Self-heal: try alternative selectors
      const altItems = document.querySelectorAll('[data-testid*="mark-unread"], button, [role="option"]');
      for (const item of altItems) {
        if (item.textContent?.trim()?.includes("Mark as unread")) {
          item.click();
          return { success: true, method: "alt-selector" };
        }
      }
      return { success: false, menuItems: [...document.querySelectorAll('[role="menuitem"]')].map(i => i.textContent?.trim()).join(", ") };
    });

    if (!clicked.success) {
      // Self-heal: maybe the context menu didn't appear. Try Playwright's click instead.
      try {
        const menuItem = page.getByRole("menuitem", { name: "Mark as unread" });
        await menuItem.click({ timeout: 3000 });
        const elapsed = Date.now() - t0;
        console.error(`${label} Marked unread in ${channelName} (${elapsed}ms, playwright-fallback)`);
        return { success: true, method: "playwright-fallback", elapsed };
      } catch {
        return { success: false, error: `Menu item not found. Available: ${clicked.menuItems}` };
      }
    }

    // Dismiss any lingering menu
    await page.evaluate(() => document.body.click());

    const elapsed = Date.now() - t0;
    console.error(`${label} Marked unread in ${channelName} (${elapsed}ms)`);
    return { success: true, elapsed, method: clicked.method || "primary" };

  } catch (e) {
    console.error(`${label} Error marking unread in ${channelName}: ${e.message}`);
    // Capture screenshot for debugging
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      await page?.screenshot({ path: join(SCREENSHOTS_DIR, `error-${ts}.png`) });
    } catch {}
    // Reset channel state so next call re-navigates
    currentChannelId = null;
    return { success: false, error: e.message };
  }
}
