const MISSING_RECEIVER_MESSAGES = [
  "Receiving end does not exist",
  "Could not establish connection",
];

function errorMessage(error) {
  return String(error && error.message ? error.message : error || "");
}

export function isMissingReceiverError(error) {
  const message = errorMessage(error);
  return MISSING_RECEIVER_MESSAGES.some(fragment => message.includes(fragment));
}

export function isHashOnlyNavigation(currentUrl, targetUrl) {
  if (typeof currentUrl !== "string" || typeof targetUrl !== "string" || currentUrl === targetUrl) {
    return false;
  }
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);
    current.hash = "";
    target.hash = "";
    return current.href === target.href;
  } catch {
    return false;
  }
}

export function shouldReuseProviderTab(options) {
  if (!options?.continuation || !options.tabUrl) return false;
  if (!options.requestedConversationId || options.currentConversationId !== options.requestedConversationId) {
    return false;
  }
  try {
    return new URL(options.tabUrl).hostname === "chatgpt.com";
  } catch {
    return false;
  }
}

export async function waitForProviderDocument(tabs, tabId, expectedUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 200;
  const missingReceiverGraceMs = options.missingReceiverGraceMs ?? 1_000;
  const now = options.now || Date.now;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  let lastTab = null;
  let lastError = null;
  let missingReceiverSince = null;
  let recoveryReloaded = false;

  while (now() < deadline) {
    lastTab = await tabs.get(tabId);
    if (lastTab.url === expectedUrl) {
      try {
        const ready = await tabs.sendMessage(tabId, { type: "codex-provider-ping" });
        if (ready && ready.ok && ready.url === expectedUrl) return lastTab;
        lastError = new Error("ChatGPT content script returned an invalid readiness response");
      } catch (error) {
        lastError = error;
      }

      if (
        !recoveryReloaded
        && lastTab.status === "complete"
        && isMissingReceiverError(lastError)
      ) {
        if (missingReceiverSince == null) missingReceiverSince = now();
        if (now() - missingReceiverSince >= missingReceiverGraceMs) {
          await tabs.reload(tabId);
          recoveryReloaded = true;
          missingReceiverSince = null;
        }
      } else if (!isMissingReceiverError(lastError)) {
        missingReceiverSince = null;
      }
    } else {
      missingReceiverSince = null;
    }
    await sleep(pollMs);
  }

  const detail = lastTab
    ? " (status=" + lastTab.status + ", url=" + lastTab.url + ")"
    : "";
  const recovery = recoveryReloaded
    ? "; the content script was still unavailable after an automatic tab reload"
    : "";
  throw new Error(
    "Timed out waiting for the ChatGPT provider document" + detail + recovery
      + (lastError ? ": " + errorMessage(lastError) : ""),
  );
}
