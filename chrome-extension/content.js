const COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  '#prompt-textarea',
  '[contenteditable="true"][data-lexical-editor="true"]',
  'form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]',
  'form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]',
].join(", ");
const SEND_BUTTON_SELECTOR = '[data-testid="send-button"], button[type="submit"]';
const STOP_BUTTON_SELECTOR = '[data-testid="stop-button"], form[data-chatgpt-composer] button[aria-label="Stop"]';
const ASSISTANT_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="assistant"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"]):not([data-turn-key] *)',
  '[data-turn-key]:has([data-conversation-role="assistant"], [data-chatgpt-agent-turn-start])',
].join(", ");
const USER_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="user"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"][data-message-author-role="user"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"]):not([data-turn-key] *)',
  '[data-turn-key]:has([data-user-message-bubble])',
].join(", ");
const ASSISTANT_ANSWER_SELECTOR = [
  ".markdown",
  '[data-message-author-role="assistant"] .puik-root.not-markdown > [class*="_DilResponseRoot"]',
  '[data-markdown-text-style="assistant-message"]',
].join(", ");
const {
  describeMismatch,
  isCompleteAgentEnvelope,
  promptTextEquivalent,
  waitForStableSingle,
} = globalThis.CodexComposerState;

let activeRun = null;

class ComposerReplacedError extends Error {}

function visible(element) {
  if (!(element instanceof HTMLElement)) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

function enabled(element) {
  return !element.matches(":disabled")
    && element.getAttribute("aria-disabled") !== "true"
    && !element.hasAttribute("disabled");
}

function composerText(composer) {
  if (typeof composer.value === "string") return composer.value;
  const clone = composer.cloneNode(true);
  clone.querySelectorAll(
    '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target], [app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]',
  ).forEach(part => part.remove());
  return [...clone.childNodes]
    .map(child => child.textContent || "")
    .join("\n")
    .trimStart();
}

function composerStructureReady(composer) {
  if (!composer.isConnected) return false;
  const form = composer.closest("form");
  return Boolean(form && form.querySelector(SEND_BUTTON_SELECTOR));
}

function assistantOwned(candidate, groupedTurn) {
  if (!groupedTurn) return true;
  const author = candidate.closest("[data-message-author-role]");
  if (author) return author.getAttribute("data-message-author-role") === "assistant";
  if (candidate.matches('[data-markdown-text-style="assistant-message"]')) return true;
  const role = candidate.closest("[data-conversation-role]");
  if (role) return role.getAttribute("data-conversation-role") === "assistant";
  const unit = candidate.closest("[data-content-search-unit-key]");
  return Boolean(unit && [...unit.children].some(
    child => child.getAttribute("data-conversation-role") === "assistant",
  ));
}

function assistantAnswerRoots(turn) {
  const candidates = [
    ...(turn.matches(ASSISTANT_ANSWER_SELECTOR) ? [turn] : []),
    ...turn.querySelectorAll(ASSISTANT_ANSWER_SELECTOR),
  ].filter(visible).filter(candidate => assistantOwned(candidate, turn.hasAttribute("data-turn-key")));
  return candidates.filter(candidate => !candidates.some(
    other => other !== candidate && other.contains(candidate),
  ));
}

function snapshots(selector, role) {
  const rows = [...document.querySelectorAll(selector)].map((element, index) => {
    const keyOwner = element.hasAttribute("data-turn-key") ? element : element.closest("[data-turn-key]");
    const key = keyOwner && keyOwner.getAttribute("data-turn-key");
    const idOwner = element.hasAttribute("data-turn-id")
      ? element
      : element.querySelector("[data-turn-id]") || element.closest("[data-turn-id]");
    const turnId = idOwner && idOwner.getAttribute("data-turn-id");
    const testId = element.getAttribute("data-testid");
    const identity = key
      ? "group:" + role + ":" + key
      : turnId
        ? "turn:" + role + ":" + turnId
        : testId
          ? "test:" + role + ":" + testId
          : "unkeyed:" + role + ":" + index;
    if (role === "assistant") {
      const roots = assistantAnswerRoots(element);
      return {
        identity,
        html: roots.map(root => root.innerHTML).join("\n"),
        text: roots.map(root => root.innerText || root.textContent || "").join("\n\n").trim(),
      };
    }
    return { identity, html: element.innerHTML, text: (element.innerText || "").trim() };
  });
  const deduped = new Map();
  for (const row of rows) deduped.set(row.identity, row);
  return [...deduped.values()];
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason || new Error("Cancelled"));
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal.reason || new Error("Cancelled"));
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

async function waitForSubmission(assistantBefore, userBefore, signal) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw signal.reason || new Error("Cancelled");
    const accepted = snapshots(ASSISTANT_TURN_SELECTOR, "assistant").some(row => !assistantBefore.has(row.identity))
      || snapshots(USER_TURN_SELECTOR, "user").some(row => !userBefore.has(row.identity))
      || [...document.querySelectorAll(STOP_BUTTON_SELECTOR)].some(visible);
    if (accepted) return;
    await sleep(250, signal);
  }
  throw new Error("ChatGPT did not confirm prompt submission; it was not retried");
}

async function waitForComposer(signal) {
  return await waitForStableSingle({
    query: () => [...document.querySelectorAll(COMPOSER_SELECTOR)].filter(visible),
    acceptable: composerStructureReady,
    timeoutMs: 30_000,
    stableMs: 1_000,
    pollMs: 100,
    sleep: ms => sleep(ms, signal),
  });
}

function selectComposerContents(composer, collapseToEnd = false) {
  composer.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  if (collapseToEnd) range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function dispatchEditorInput(composer, prompt) {
  composer.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    composed: true,
    inputType: "insertText",
    data: prompt,
  }));
}

function setNativeValue(composer, prompt) {
  const prototype = composer instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : composer instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : null;
  const setter = prototype && Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!setter) return false;
  setter.call(composer, prompt);
  dispatchEditorInput(composer, prompt);
  return true;
}

function clearComposer(composer) {
  if (setNativeValue(composer, "")) return true;
  selectComposerContents(composer, false);
  if (!composerText(composer)) return true;
  return document.execCommand("delete", false);
}

function insertPrompt(composer, prompt) {
  if (setNativeValue(composer, prompt)) return true;
  composer.focus();
  if (document.activeElement !== composer) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  const alreadyPlaced = selection.isCollapsed
    && selection.anchorNode !== null
    && composer.contains(selection.anchorNode);
  if (!alreadyPlaced) selectComposerContents(composer, true);
  if (
    !selection.isCollapsed
    || !selection.anchorNode
    || !composer.contains(selection.anchorNode)
  ) {
    return false;
  }
  return document.execCommand("insertText", false, prompt);
}

async function waitForPromptRetention(composer, prompt, signal, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let actual = "";
  while (Date.now() < deadline) {
    if (!composer.isConnected) throw new ComposerReplacedError("ChatGPT replaced the composer during prompt insertion");
    actual = composerText(composer);
    if (promptTextEquivalent(prompt, actual)) return;
    await sleep(100, signal);
  }
  throw new Error(describeMismatch(prompt, actual, composer.isConnected));
}

async function attachPrompt(composer, prompt, signal) {
  if (!clearComposer(composer)) {
    throw new Error("ChatGPT composer rejected the native clear command");
  }
  await waitForPromptRetention(composer, "", signal, 2_000);
  if (!insertPrompt(composer, prompt)) {
    throw new Error("ChatGPT composer rejected the plain-text editing command");
  }
  await waitForPromptRetention(composer, prompt, signal, 10_000);
}

async function waitForSendButton(form, composer, prompt, signal) {
  const deadline = Date.now() + 20_000;
  let visibleCount = 0;
  while (Date.now() < deadline) {
    if (signal.aborted) throw signal.reason || new Error("Cancelled");
    if (!composer.isConnected || composer.closest("form") !== form) {
      throw new ComposerReplacedError("ChatGPT replaced the composer before submission");
    }
    if (!promptTextEquivalent(prompt, composerText(composer))) {
      throw new ComposerReplacedError(describeMismatch(prompt, composerText(composer), composer.isConnected));
    }
    const matches = [...form.querySelectorAll(SEND_BUTTON_SELECTOR)].filter(visible);
    visibleCount = matches.length;
    if (matches.length === 1 && enabled(matches[0])) return matches[0];
    await sleep(100, signal);
  }
  throw new Error(
    visibleCount === 1
      ? "ChatGPT send button remained disabled after the complete prompt was attached"
      : "ChatGPT send button expected exactly one visible element, found " + visibleCount,
  );
}

async function waitForAnswer(assistantBefore, timeoutMs, signal, agentNonce) {
  const deadline = Date.now() + timeoutMs;
  let identity = null;
  let lastText = "";
  let stable = 0;
  while (Date.now() < deadline) {
    if (signal.aborted) throw signal.reason || new Error("Cancelled");
    const fresh = snapshots(ASSISTANT_TURN_SELECTOR, "assistant").filter(row => !assistantBefore.has(row.identity));
    if (fresh.length > 1) throw new Error("More than one new ChatGPT assistant turn appeared");
    if (fresh.length === 1) {
      if (identity && identity !== fresh[0].identity) throw new Error("The bound assistant turn changed identity");
      identity = fresh[0].identity;
      const text = fresh[0].text;
      stable = text && text === lastText ? stable + 1 : 0;
      lastText = text;
      if (agentNonce) {
        // ChatGPT can pause while streaming a large JSON tool call. Its stop
        // control is not a reliable completion signal across UI versions, so
        // agent mode waits for the nonce-bound envelope to be complete JSON.
        if (isCompleteAgentEnvelope(text, agentNonce)) return fresh[0];
        await sleep(700, signal);
        continue;
      }
      const generating = [...document.querySelectorAll(STOP_BUTTON_SELECTOR)].some(visible);
      if (!generating && text && stable >= 2) return fresh[0];
    }
    await sleep(700, signal);
  }
  throw new Error("Timed out waiting for the bound ChatGPT assistant turn");
}

async function runPrompt(message, signal) {
  if (location.hostname !== "chatgpt.com") throw new Error("Provider tab is not on chatgpt.com");
  const assistantBefore = new Set(snapshots(ASSISTANT_TURN_SELECTOR, "assistant").map(row => row.identity));
  const userBefore = new Set(snapshots(USER_TURN_SELECTOR, "user").map(row => row.identity));

  let sendButton = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const composer = await waitForComposer(signal);
    try {
      await attachPrompt(composer, message.prompt, signal);
      const form = composer.closest("form");
      if (!form) throw new ComposerReplacedError("ChatGPT composer form was replaced");
      sendButton = await waitForSendButton(form, composer, message.prompt, signal);
      break;
    } catch (error) {
      if (!(error instanceof ComposerReplacedError) || attempt === 2) throw error;
    }
  }
  if (!sendButton) throw new Error("ChatGPT composer could not be prepared for submission");
  sendButton.click();
  await waitForSubmission(assistantBefore, userBefore, signal);
  return waitForAnswer(
    assistantBefore,
    Number(message.timeoutMs) || 600_000,
    signal,
    typeof message.agentNonce === "string" ? message.agentNonce : null,
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "codex-provider-ping") {
    sendResponse({ ok: true, url: location.href, readyState: document.readyState });
    return false;
  }
  if (message.type === "codex-provider-cancel") {
    if (activeRun && activeRun.id === message.id) {
      activeRun.controller.abort(new Error("Codex cancelled the browser turn"));
      const stop = [...document.querySelectorAll(STOP_BUTTON_SELECTOR)].find(visible);
      if (stop) stop.click();
    }
    sendResponse({ ok: true });
    return false;
  }
  if (message.type !== "codex-provider-run") return false;
  if (activeRun) {
    sendResponse({ ok: false, error: "The ChatGPT provider tab is already busy", code: "browser_busy" });
    return false;
  }
  const controller = new AbortController();
  activeRun = { id: message.id, controller };
  runPrompt(message, controller.signal).then(
    row => sendResponse({ ok: true, html: row.html, text: row.text, identity: row.identity, url: location.href }),
    error => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: controller.signal.aborted ? "browser_cancelled" : "chatgpt_dom_or_session_error",
    }),
  ).finally(() => {
    activeRun = null;
  });
  return true;
});
