/**
 * graph-helpers.mjs - Graph API access for Chat operations.
 *
 * Uses OAuth2 device code flow for auth (no external dependencies).
 * The az CLI token doesn't include Chat.ReadWrite, so we maintain our own
 * token via the "Microsoft Graph Command Line Tools" first-party app
 * (pre-consented in most enterprise tenants).
 *
 * Auth flow:
 *   1. First run: interactive device code flow (user opens URL, enters code)
 *   2. Refresh token cached in .agents/state/graph-chat-auth.json
 *   3. Subsequent runs: silent token refresh (no interaction)
 *   4. Refresh tokens last ~90 days; re-auth via auth.cmd if expired
 *
 * Exported:
 *   init(options)           - Initialize with stateDir, optional tenantId/clientId
 *   deviceCodeAuth()        - Interactive setup (run during auth.cmd)
 *   markSelfChatUnread()    - Mark self-DM chat as unread (best-effort, never throws)
 *   hasAuth()               - Check if cached credentials exist
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const label = "[graph]";

// Microsoft Graph Command Line Tools - pre-consented in most enterprise tenants
const DEFAULT_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";
const SCOPES = "Chat.ReadWrite offline_access";

let tenantId = null;
let clientId = null;
let authFile = null;
let accessToken = null;
let tokenExpiry = 0;
let refreshToken = null;
let userInfo = null;
let selfChatId = null;
let initialized = false;

// --- Initialization ---

export function init(options = {}) {
  const stateDir = options.stateDir;
  if (!stateDir) throw new Error("stateDir is required");
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

  authFile = join(stateDir, "graph-chat-auth.json");
  clientId = options.clientId || DEFAULT_CLIENT_ID;
  tenantId = options.tenantId || detectTenantId();

  // Load cached refresh token
  try {
    const data = JSON.parse(readFileSync(authFile, "utf-8"));
    refreshToken = data.refreshToken;
    if (data.tenantId) tenantId = data.tenantId;
    if (data.clientId) clientId = data.clientId;
    console.error(`${label} Loaded cached auth (tenant: ${tenantId})`);
  } catch {
    // No cached auth yet
  }

  initialized = true;
}

function detectTenantId() {
  try {
    return execSync('az account show --query tenantId -o tsv', {
      encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"]
    }).trim();
  } catch {
    return "common";
  }
}

function saveAuth() {
  if (!authFile) return;
  try {
    writeFileSync(authFile, JSON.stringify({
      refreshToken,
      tenantId,
      clientId,
      savedAt: new Date().toISOString()
    }));
  } catch (e) {
    console.error(`${label} Failed to save auth: ${e.message}`);
  }
}

// --- Token management ---

async function refreshAccessToken() {
  if (!refreshToken) return null;

  try {
    const resp = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          scope: SCOPES
        }),
        signal: AbortSignal.timeout(15000)
      }
    );

    if (!resp.ok) {
      const err = (await resp.text().catch(() => "")).slice(0, 200);
      console.error(`${label} Token refresh failed (${resp.status}): ${err}`);
      refreshToken = null;
      return null;
    }

    const data = await resp.json();
    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
    if (data.refresh_token) {
      refreshToken = data.refresh_token;
      saveAuth();
    }
    return accessToken;
  } catch (e) {
    console.error(`${label} Token refresh error: ${e.message}`);
    return null;
  }
}

async function getToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;
  return refreshAccessToken();
}

// --- Interactive auth (for setup) ---

export async function deviceCodeAuth(options = {}) {
  if (!initialized) init(options);

  console.error(`\n${label} Graph API Chat Authentication`);
  console.error(`${label} Client: ${clientId}`);
  console.error(`${label} Tenant: ${tenantId}`);
  console.error(`${label} Scopes: ${SCOPES}\n`);

  const codeResp = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/devicecode`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, scope: SCOPES })
    }
  );

  if (!codeResp.ok) {
    const err = await codeResp.text();
    throw new Error(`Device code request failed: ${err}`);
  }

  const codeData = await codeResp.json();

  console.error("=".repeat(60));
  console.error(codeData.message);
  console.error("=".repeat(60));
  console.error("");

  const interval = (codeData.interval || 5) * 1000;
  const expiresAt = Date.now() + codeData.expires_in * 1000;

  while (Date.now() < expiresAt) {
    await new Promise(r => setTimeout(r, interval));

    const tokenResp = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: codeData.device_code
        })
      }
    );

    const tokenData = await tokenResp.json();

    if (tokenData.access_token) {
      accessToken = tokenData.access_token;
      tokenExpiry = Date.now() + (tokenData.expires_in - 300) * 1000;
      refreshToken = tokenData.refresh_token;
      saveAuth();
      console.error(`${label} Authentication successful! Refresh token cached.`);
      return { success: true };
    }

    if (tokenData.error === "authorization_pending") continue;
    if (tokenData.error === "slow_down") {
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    throw new Error(tokenData.error_description || tokenData.error);
  }

  throw new Error("Device code expired (user did not complete sign-in in time)");
}

// --- Graph API fetch ---

async function graphFetch(method, path, body) {
  const token = await getToken();
  if (!token) return null;

  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000)
  };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  const resp = await fetch(`https://graph.microsoft.com/v1.0${path}`, opts);
  if (resp.status === 204) return null;
  if (!resp.ok) {
    const text = (await resp.text().catch(() => "")).slice(0, 200);
    throw new Error(`${resp.status}: ${text}`);
  }
  return resp.json();
}

// --- User & chat discovery (cached for session lifetime) ---

async function ensureUserInfo() {
  if (userInfo) return userInfo;

  const me = await graphFetch("GET", "/me?$select=id");
  if (!me) return null;

  const org = await graphFetch("GET", "/organization?$select=id");
  userInfo = {
    id: me.id,
    tenantId: org?.value?.[0]?.id || tenantId
  };
  console.error(`${label} User: ${userInfo.id}`);
  return userInfo;
}

async function ensureSelfChatId() {
  if (selfChatId) return selfChatId;

  const ui = await ensureUserInfo();
  if (!ui) return null;

  const result = await graphFetch(
    "GET",
    "/me/chats?$filter=chatType eq 'oneOnOne'&$expand=members&$top=50"
  );
  if (!result) return null;

  for (const chat of result.value || []) {
    const members = (chat.members || []).filter(
      m => m["@odata.type"] === "#microsoft.graph.aadUserConversationMember"
    );
    const uniqueUserIds = new Set(members.map(m => m.userId).filter(Boolean));
    if (uniqueUserIds.size === 1 && uniqueUserIds.has(ui.id)) {
      selfChatId = chat.id;
      console.error(`${label} Self-chat found`);
      return selfChatId;
    }
  }

  console.error(`${label} Self-chat not found in recent chats`);
  return null;
}

// --- Public API ---

export function hasAuth() {
  return !!refreshToken;
}

/**
 * Mark the self-DM chat as unread. Best-effort: never throws to callers.
 */
export async function markSelfChatUnread() {
  if (!initialized || !refreshToken) {
    return { success: false, error: "No Graph chat auth" };
  }

  try {
    const chatId = await ensureSelfChatId();
    if (!chatId) return { success: false, error: "Self-chat not found" };

    await graphFetch("POST", `/chats/${chatId}/markChatUnreadForUser`, {
      user: { id: userInfo.id, tenantId: userInfo.tenantId }
    });

    return { success: true };
  } catch (e) {
    console.error(`${label} markSelfChatUnread: ${e.message}`);
    return { success: false, error: e.message };
  }
}
