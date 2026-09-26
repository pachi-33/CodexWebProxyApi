import assert from "node:assert/strict";
import test from "node:test";
import {
  isHashOnlyNavigation,
  isMissingReceiverError,
  shouldReuseProviderTab,
  waitForProviderDocument,
} from "../chrome-extension/tab-readiness.js";

test("provider tab is reused only for the same continuation conversation", () => {
  const base = {
    continuation: true,
    tabUrl: "https://chatgpt.com/c/current?temporary-chat=true",
    currentConversationId: "conversation-a",
    requestedConversationId: "conversation-a",
  };
  assert.equal(shouldReuseProviderTab(base), true);
  assert.equal(shouldReuseProviderTab({ ...base, continuation: false }), false);
  assert.equal(shouldReuseProviderTab({ ...base, requestedConversationId: "conversation-b" }), false);
  assert.equal(shouldReuseProviderTab({ ...base, tabUrl: "https://example.com/" }), false);
});

test("provider URL changes that alter only the hash are same-document navigations", () => {
  assert.equal(isHashOnlyNavigation(
    "https://chatgpt.com/?temporary-chat=true#codex-provider-old",
    "https://chatgpt.com/?temporary-chat=true#codex-provider-new",
  ), true);
  assert.equal(isHashOnlyNavigation(
    "https://chatgpt.com/c/old#codex-provider-old",
    "https://chatgpt.com/?temporary-chat=true#codex-provider-new",
  ), false);
  assert.equal(isHashOnlyNavigation(
    "https://chatgpt.com/?temporary-chat=true#same",
    "https://chatgpt.com/?temporary-chat=true#same",
  ), false);
});

test("Chrome missing-receiver errors are recognized", () => {
  assert.equal(isMissingReceiverError(new Error(
    "Could not establish connection. Receiving end does not exist.",
  )), true);
  assert.equal(isMissingReceiverError(new Error("ChatGPT is still rendering")), false);
});

test("readiness handshake reloads a complete tab once when its content script is missing", async () => {
  const expectedUrl = "https://chatgpt.com/?temporary-chat=true#codex-provider-test";
  let reloads = 0;
  let now = 0;
  const tabs = {
    get: async id => ({ id, status: "complete", url: expectedUrl }),
    sendMessage: async () => {
      if (!reloads) throw new Error("Could not establish connection. Receiving end does not exist.");
      return { ok: true, url: expectedUrl, readyState: "complete" };
    },
    reload: async id => {
      assert.equal(id, 42);
      reloads += 1;
    },
  };

  const tab = await waitForProviderDocument(tabs, 42, expectedUrl, {
    timeoutMs: 100,
    pollMs: 1,
    missingReceiverGraceMs: 0,
    now: () => now,
    sleep: async ms => { now += ms; },
  });

  assert.equal(tab.id, 42);
  assert.equal(reloads, 1);
});

test("persistent missing receiver performs only one recovery reload", async () => {
  const expectedUrl = "https://chatgpt.com/?temporary-chat=true#codex-provider-test";
  let reloads = 0;
  let now = 0;
  const tabs = {
    get: async id => ({ id, status: "complete", url: expectedUrl }),
    sendMessage: async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    },
    reload: async () => { reloads += 1; },
  };

  await assert.rejects(
    waitForProviderDocument(tabs, 42, expectedUrl, {
      timeoutMs: 5,
      pollMs: 1,
      missingReceiverGraceMs: 0,
      now: () => now,
      sleep: async ms => { now += ms; },
    }),
    /after an automatic tab reload.*Receiving end does not exist/,
  );
  assert.equal(reloads, 1);
});
