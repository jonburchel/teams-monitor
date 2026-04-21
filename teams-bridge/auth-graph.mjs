/**
 * auth-graph.mjs - One-time Graph API authentication for Chat operations.
 *
 * Run: node auth-graph.mjs
 *
 * Opens a device code flow: go to the URL, enter the code, sign in.
 * Caches the refresh token so subsequent service runs authenticate silently.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { init, deviceCodeAuth, hasAuth } from "./graph-helpers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const stateDir = join(__dirname, "..", ".agents", "state");

init({ stateDir });

if (hasAuth()) {
  console.error("[auth] Existing Graph chat auth found. Re-authenticating to refresh...");
}

try {
  await deviceCodeAuth();
  console.error("\n[auth] Done! Mark-unread will work automatically on next service start.");
  process.exit(0);
} catch (e) {
  console.error(`\n[auth] Failed: ${e.message}`);
  process.exit(1);
}
