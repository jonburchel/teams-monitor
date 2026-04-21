/**
 * graph-helpers.mjs - Direct Microsoft Graph API calls.
 *
 * Uses `az account get-access-token` for auth (same pattern as create-subscriptions.ps1).
 * All operations are best-effort and never throw to callers.
 *
 * Exported:
 *   markSelfChatUnread() - Mark the self-DM chat as unread so the notification badge persists.
 */

import { execSync } from "node:child_process";

const label = "[graph]";

let cachedToken = null;
let tokenExpiry = 0;
let userInfo = null;     // { id, tenantId }
let selfChatId = null;

// --- Token management ---

function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  try {
    const raw = execSync(
      'az account get-access-token --resource https://graph.microsoft.com -o json',
      { encoding: "utf-8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] }
    );
    const parsed = JSON.parse(raw);
    cachedToken = parsed.accessToken;
    // Cache until 5 minutes before expiry
    tokenExpiry = new Date(parsed.expiresOn).getTime() - 300000;
    return cachedToken;
  } catch (e) {
    console.error(`${label} Token error: ${e.message?.split("\n")[0]}`);
    return null;
  }
}

// --- Graph API fetch ---

async function graphFetch(method, path, body) {
  const token = getToken();
  if (!token) throw new Error("No Graph token (is az CLI logged in?)");

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

// --- User & chat discovery (cached) ---

async function ensureUserInfo() {
  if (userInfo) return userInfo;

  const me = await graphFetch("GET", "/me?$select=id");
  const org = await graphFetch("GET", "/organization?$select=id");
  userInfo = {
    id: me.id,
    tenantId: org.value?.[0]?.id
  };
  console.error(`${label} User: ${userInfo.id}, Tenant: ${userInfo.tenantId}`);
  return userInfo;
}

async function ensureSelfChatId() {
  if (selfChatId) return selfChatId;

  const { id: userId } = await ensureUserInfo();

  // List recent oneOnOne chats and find the self-chat
  const result = await graphFetch(
    "GET",
    "/me/chats?$filter=chatType eq 'oneOnOne'&$expand=members&$top=50"
  );

  for (const chat of result.value || []) {
    const members = (chat.members || []).filter(
      m => m["@odata.type"] === "#microsoft.graph.aadUserConversationMember"
    );
    // Self-chat: only one unique user across all members
    const uniqueUserIds = new Set(members.map(m => m.userId).filter(Boolean));
    if (uniqueUserIds.size === 1 && uniqueUserIds.has(userId)) {
      selfChatId = chat.id;
      console.error(`${label} Self-chat: ${selfChatId}`);
      return selfChatId;
    }
  }

  console.error(`${label} Self-chat not found in recent chats`);
  return null;
}

// --- Public API ---

/**
 * Mark the self-DM chat as unread. Call after SendMessageToSelf
 * to ensure the notification badge persists.
 * Best-effort: never throws.
 */
export async function markSelfChatUnread() {
  try {
    const chatId = await ensureSelfChatId();
    if (!chatId) return { success: false, error: "Self-chat not found" };

    const { id: userId, tenantId } = userInfo;

    await graphFetch("POST", `/chats/${chatId}/markChatUnreadForUser`, {
      user: { id: userId, tenantId }
    });

    return { success: true };
  } catch (e) {
    console.error(`${label} markSelfChatUnread failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}
