/**
 * Direct Graph API client for message reactions.
 * 
 * Uses MSAL with the Agency CLI's client ID for authentication.
 * On first use, requires a one-time device code authentication.
 * Tokens are cached in the state directory for subsequent runs.
 */

import { PublicClientApplication, LogLevel } from "@azure/msal-node";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const CLIENT_ID = "aebc6443-996d-45c2-90f0-388ff96faa56";
const TENANT_ID = "888d76fa-54b2-4ced-8ee5-aac1585adee7";
const AUTHORITY = `https://login.microsoftonline.com/${TENANT_ID}`;
const SCOPES = ["https://graph.microsoft.com/ChannelMessage.Send"];
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

let pca = null;
let cachedAccount = null;
let disabled = false;

export async function initGraphReactions(stateDir, label = "") {
  const cacheFile = join(stateDir, "msal-token-cache.json");

  const cachePlugin = {
    beforeCacheAccess: async (context) => {
      try {
        if (existsSync(cacheFile)) {
          context.tokenCache.deserialize(readFileSync(cacheFile, "utf-8"));
        }
      } catch {}
    },
    afterCacheAccess: async (context) => {
      if (context.cacheHasChanged) {
        try { writeFileSync(cacheFile, context.tokenCache.serialize()); } catch {}
      }
    }
  };

  pca = new PublicClientApplication({
    auth: { clientId: CLIENT_ID, authority: AUTHORITY },
    cache: { cachePlugin },
    system: { loggerOptions: { logLevel: LogLevel.Warning } }
  });

  // Try to find a cached account
  const accounts = await pca.getTokenCache().getAllAccounts();
  if (accounts.length > 0) {
    cachedAccount = accounts[0];
    // Verify we can get a token silently
    try {
      await pca.acquireTokenSilent({ scopes: SCOPES, account: cachedAccount });
      console.error(`${label} Graph reactions: authenticated as ${cachedAccount.username}`);
      return true;
    } catch {
      cachedAccount = null;
    }
  }

  // No cached token; do device code flow (blocks briefly for user auth)
  try {
    console.error(`${label} Graph reactions: one-time authentication required...`);
    const result = await pca.acquireTokenByDeviceCode({
      scopes: SCOPES,
      deviceCodeCallback: (response) => {
        console.error(`${label} AUTH REQUIRED: ${response.message}`);
      }
    });
    cachedAccount = result.account;
    console.error(`${label} Graph reactions: authenticated as ${cachedAccount.username}`);
    return true;
  } catch (e) {
    console.error(`${label} Graph reactions: auth failed (${e.message}). Reactions disabled.`);
    disabled = true;
    return false;
  }
}

async function getToken() {
  if (disabled || !pca || !cachedAccount) return null;
  try {
    const result = await pca.acquireTokenSilent({ scopes: SCOPES, account: cachedAccount });
    return result.accessToken;
  } catch (e) {
    console.error(`[graph] Token refresh failed: ${e.message}`);
    disabled = true;
    return null;
  }
}

export async function setReaction(teamId, channelId, messageId, emoji) {
  const token = await getToken();
  if (!token) return;
  try {
    const url = `${GRAPH_BASE}/teams/${teamId}/channels/${channelId}/messages/${messageId}/setReaction`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reactionType: emoji }),
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok && resp.status !== 204) {
      const body = await resp.text().catch(() => "");
      console.error(`[graph] setReaction ${resp.status}: ${body.slice(0, 150)}`);
    }
  } catch (e) {
    console.error(`[graph] setReaction error: ${e.message}`);
  }
}

export async function unsetReaction(teamId, channelId, messageId, emoji) {
  const token = await getToken();
  if (!token) return;
  try {
    const url = `${GRAPH_BASE}/teams/${teamId}/channels/${channelId}/messages/${messageId}/unsetReaction`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reactionType: emoji }),
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok && resp.status !== 204) {
      const body = await resp.text().catch(() => "");
      console.error(`[graph] unsetReaction ${resp.status}: ${body.slice(0, 150)}`);
    }
  } catch (e) {
    console.error(`[graph] unsetReaction error: ${e.message}`);
  }
}
