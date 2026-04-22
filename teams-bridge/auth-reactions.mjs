/**
 * One-time auth for Graph API message reactions.
 * Run this from auth.cmd or standalone to cache credentials.
 */

import { initGraphReactions } from "./graph-reactions.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const stateDir = join(__dirname, "..", ".agents", "state");
if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

const ok = await initGraphReactions(stateDir, "[auth]");
if (ok) {
  console.log("\n✅ Graph API reactions authenticated successfully.");
} else {
  console.log("\n⚠️  Graph API auth failed. Reactions will be disabled.");
  console.log("   You can retry later by running: node teams-bridge/auth-reactions.mjs");
}
process.exit(ok ? 0 : 1);
