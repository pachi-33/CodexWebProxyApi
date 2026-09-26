import { shouldReuseProviderTab, waitForProviderDocument } from "./tab-readiness.js";

const WS_URL = "ws://127.0.0.1:4319";
const TEMP_CHAT_URL = "https://chatgpt.com/?temporary-chat=true#codex-provider-";

let socket = null;
let reconnectTimer = null;
let keepaliveTimer = null;
let providerTabId = null;
let providerConversationId = null;
let activeProviderRunId = null;

function send(value) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 1000);
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  try {
    socket = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }
  socket.onopen = () => {
    send({
      type: "hello",
      protocolVersion: 1,
      extensionVersion: chrome.runtime.getManifest().version,
    });
    clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => send({ type: "keepalive", at: Date.now() }), 20_000);
  };
  socket.onmessage = event => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "run") void runInProviderTab(message);
    if (message.type === "cancel") void cancelProviderTab(message.id);
  };
  socket.onclose = () => {
    socket = null;
    clearInterval(keepaliveTimer);
    scheduleReconnect();
  };
  socket.onerror = () => socket && socket.close();
}

async function existingProviderTab() {
  if (providerTabId != null) {
    try {
      return await chrome.tabs.get(providerTabId);
    } catch {
      providerTabId = null;
      providerConversationId = null;
    }
  }
  const candidates = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  const existing = candidates.find(tab => typeof tab.url === "string" && tab.url.includes("#codex-provider"));
  if (existing) {
    providerTabId = existing.id;
    return existing;
  }
  return null;
}

async function sendToContentScript(tabId, message) {
  const deadline = Date.now() + 15_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  throw lastError || new Error("ChatGPT content script did not become ready");
}

async function prepareProviderTab(message) {
  let tab = await existingProviderTab();
  if (tab && shouldReuseProviderTab({
    continuation: message.continuation,
    tabUrl: tab.url,
    currentConversationId: providerConversationId,
    requestedConversationId: message.conversationId,
  })) {
    tab = await chrome.tabs.update(tab.id, { active: true });
    const ready = await waitForProviderDocument(chrome.tabs, tab.id, tab.url);
    return { tab: ready, reused: true };
  }

  const targetUrl = TEMP_CHAT_URL + encodeURIComponent(message.id);
  if (!tab) {
    tab = await chrome.tabs.create({ url: targetUrl, active: true });
    providerTabId = tab.id;
  } else if (tab.url !== targetUrl) {
    tab = await chrome.tabs.update(tab.id, { url: targetUrl, active: true });
  } else {
    tab = await chrome.tabs.update(tab.id, { active: true });
  }
  providerConversationId = message.conversationId || message.id;
  return { tab: await waitForProviderDocument(chrome.tabs, tab.id, targetUrl), reused: false };
}

async function runInProviderTab(message) {
  if (activeProviderRunId) {
    send({
      type: "result",
      id: message.id,
      ok: false,
      error: "The ChatGPT provider tab is already waiting for a complete response",
      code: "browser_busy",
    });
    return;
  }
  activeProviderRunId = message.id;
  try {
    const prepared = await prepareProviderTab(message);
    const prompt = prepared.reused ? message.prompt : (message.recoveryPrompt || message.prompt);
    const result = await sendToContentScript(prepared.tab.id, {
      type: "codex-provider-run",
      id: message.id,
      prompt,
      timeoutMs: message.timeoutMs,
      agentNonce: message.agentNonce,
    });
    send({ type: "result", id: message.id, ...result });
  } catch (error) {
    send({
      type: "result",
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: "chrome_extension_error",
    });
  } finally {
    if (activeProviderRunId === message.id) activeProviderRunId = null;
  }
}

async function cancelProviderTab(id) {
  const tab = await existingProviderTab();
  if (!tab) return;
  await chrome.tabs.sendMessage(tab.id, { type: "codex-provider-cancel", id }).catch(() => {});
}

chrome.action.onClicked.addListener(async () => {
  try {
    const tab = await existingProviderTab();
    if (tab) await chrome.tabs.update(tab.id, { active: true });
    else {
      const created = await chrome.tabs.create({ url: TEMP_CHAT_URL + "manual", active: true });
      providerTabId = created.id;
      providerConversationId = null;
    }
  } catch {
    // The next provider request will recreate the tab.
  }
});

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
connect();
