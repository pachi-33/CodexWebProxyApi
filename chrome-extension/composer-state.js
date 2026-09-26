(function installComposerState(root) {
  function normalizeEditorText(value) {
    return String(value || "").replace(/\r\n?/g, "\n");
  }

  function codeUnitEquivalent(expected, observed, index) {
    if (expected[index] === observed[index]) return true;
    if (expected[index] !== " " || observed[index] !== "\u00a0") return false;
    return expected[index - 1] === " " || expected[index + 1] === " ";
  }

  function promptTextEquivalent(expectedValue, observedValue) {
    const expected = normalizeEditorText(expectedValue);
    const observed = normalizeEditorText(observedValue);
    if (expected.length !== observed.length) return false;
    for (let index = 0; index < expected.length; index += 1) {
      if (!codeUnitEquivalent(expected, observed, index)) return false;
    }
    return true;
  }

  function extractJsonObjectAfterMarker(value, marker) {
    const text = String(value || "");
    const markerIndex = text.lastIndexOf(marker);
    if (markerIndex < 0) return null;
    const tail = text.slice(markerIndex + marker.length);
    const start = tail.indexOf("{");
    if (start < 0) return null;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < tail.length; index += 1) {
      const char = tail[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) return tail.slice(start, index + 1);
      }
    }
    return null;
  }

  function isCompleteAgentEnvelope(value, nonce) {
    if (typeof nonce !== "string" || !nonce) return false;
    const jsonText = extractJsonObjectAfterMarker(
      value,
      "CODEX_PROVIDER_RESULT_" + nonce,
    );
    if (!jsonText) return false;
    let payload;
    try {
      payload = JSON.parse(jsonText);
    } catch {
      return false;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.nonce !== nonce) {
      return false;
    }
    if (payload.kind === "final") return typeof payload.text === "string";
    return payload.kind === "tool_calls"
      && Array.isArray(payload.calls)
      && payload.calls.length >= 1
      && payload.calls.length <= 8;
  }

  function firstDifference(expected, actual) {
    const limit = Math.min(expected.length, actual.length);
    for (let index = 0; index < limit; index += 1) {
      if (!codeUnitEquivalent(expected, actual, index)) return index;
    }
    return expected.length === actual.length ? -1 : limit;
  }

  function describeMismatch(expectedValue, actualValue, connected) {
    const expected = normalizeEditorText(expectedValue);
    const actual = normalizeEditorText(actualValue);
    return "Composer did not retain the complete prompt"
      + " (expected_length=" + expected.length
      + ", actual_length=" + actual.length
      + ", first_difference=" + firstDifference(expected, actual)
      + ", connected=" + Boolean(connected) + ")";
  }

  async function waitForStableSingle(options) {
    const query = options.query;
    const acceptable = options.acceptable || (() => true);
    const timeoutMs = options.timeoutMs ?? 30_000;
    const stableMs = options.stableMs ?? 1_000;
    const pollMs = options.pollMs ?? 100;
    const now = options.now || Date.now;
    const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const deadline = now() + timeoutMs;
    let candidate = null;
    let stableSince = 0;
    let lastCount = 0;

    while (now() < deadline) {
      const matches = query();
      lastCount = matches.length;
      if (matches.length === 1 && acceptable(matches[0])) {
        if (candidate !== matches[0]) {
          candidate = matches[0];
          stableSince = now();
        } else if (now() - stableSince >= stableMs) {
          return candidate;
        }
      } else {
        candidate = null;
        stableSince = 0;
      }
      await sleep(pollMs);
    }
    throw new Error("ChatGPT composer did not become stable; last visible count=" + lastCount);
  }

  root.CodexComposerState = Object.freeze({
    describeMismatch,
    extractJsonObjectAfterMarker,
    firstDifference,
    isCompleteAgentEnvelope,
    normalizeEditorText,
    promptTextEquivalent,
    waitForStableSingle,
  });
})(globalThis);
