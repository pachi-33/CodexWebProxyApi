import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../chrome-extension/composer-state.js", import.meta.url), "utf8");
const context = vm.createContext({ globalThis: {} });
vm.runInContext(source, context);
const {
  describeMismatch,
  extractJsonObjectAfterMarker,
  isCompleteAgentEnvelope,
  normalizeEditorText,
  promptTextEquivalent,
  waitForStableSingle,
} = context.globalThis.CodexComposerState;

test("composer comparison preserves text and accepts NBSP only inside multi-space runs", () => {
  assert.equal(normalizeEditorText("a\r\nb"), "a\nb");
  assert.equal(promptTextEquivalent("a  b", "a \u00a0b"), true);
  assert.equal(promptTextEquivalent("a b", "a\u00a0b"), false);
  assert.equal(promptTextEquivalent("a\nb", "ab"), false);
  assert.match(
    describeMismatch("abcdef", "abcX", false),
    /expected_length=6, actual_length=4, first_difference=3, connected=false/,
  );
});

test("agent envelope completion rejects a streamed prefix and accepts only complete nonce-bound JSON", () => {
  const nonce = "92e955b1011e2ace859911a3";
  const marker = "CODEX_PROVIDER_RESULT_" + nonce;
  assert.equal(isCompleteAgentEnvelope(marker + '\n{"nonce":"' + nonce + '","kind":"tool_calls","calls":', nonce), false);
  assert.equal(isCompleteAgentEnvelope(marker + '\n{"nonce":"wrong","kind":"final","text":"done"}', nonce), false);
  const payload = {
    nonce,
    kind: "tool_calls",
    calls: [{ tool: "t0", arguments: { cmd: "printf 'brace } quote \\\" ok'" } }],
  };
  const complete = marker + "\n" + JSON.stringify(payload);
  assert.equal(isCompleteAgentEnvelope(complete, nonce), true);
  assert.deepEqual(JSON.parse(extractJsonObjectAfterMarker(complete, marker)), payload);
});

test("composer readiness waits through hydration and node replacement", async () => {
  const transitional = { name: "transitional" };
  const hydrated = { name: "hydrated" };
  const states = [[], [transitional], [hydrated], [hydrated], [hydrated]];
  let step = 0;
  let now = 0;
  const result = await waitForStableSingle({
    query: () => states[Math.min(step, states.length - 1)],
    acceptable: candidate => candidate === hydrated,
    timeoutMs: 20,
    stableMs: 2,
    pollMs: 1,
    now: () => now,
    sleep: async ms => {
      now += ms;
      step += 1;
    },
  });
  assert.equal(result, hydrated);
});

test("composer readiness reports the last visible count on timeout", async () => {
  let now = 0;
  await assert.rejects(
    waitForStableSingle({
      query: () => [],
      timeoutMs: 3,
      pollMs: 1,
      now: () => now,
      sleep: async ms => { now += ms; },
    }),
    /last visible count=0/,
  );
});
