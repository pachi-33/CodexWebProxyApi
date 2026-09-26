import assert from "node:assert/strict";
import test from "node:test";
import { augmentModelCatalog } from "../src/native-proxy.mjs";
import { createResponseEnvelope, ResponsesSSE, resultToOutput } from "../src/responses-wire.mjs";

test("catalog keeps native rows and adds read-only and agent browser models", () => {
  const source = { models: [{
    slug: "gpt-native",
    display_name: "Native",
    supported_in_api: true,
    comp_hash: "native-only",
  }] };
  const result = augmentModelCatalog(source);
  assert.deepEqual(result.models.map(model => model.slug), ["gpt-native", "chatgpt-web/browser", "chatgpt-web/agent"]);
  assert.equal(result.models[1].comp_hash, undefined);
  assert.deepEqual(result.models[1].input_modalities, ["text"]);
  assert.equal(result.models[1].multi_agent_version, "disabled");
  assert.equal(result.models[2].tool_mode, null);
  assert.equal(source.models.length, 1);
});

test("agent tool result becomes standard Responses function-call SSE", () => {
  let output = "";
  const res = {
    write(value) { output += value; },
    end(value = "") { output += value; },
  };
  const envelope = createResponseEnvelope("chatgpt-web/agent", null);
  const items = resultToOutput(envelope, {
    kind: "tool_calls",
    calls: [{ type: "function", name: "exec_command", arguments: '{"cmd":"pwd"}' }],
  });
  const wire = new ResponsesSSE(res, envelope);
  wire.created();
  wire.completeOutput(items);
  assert.match(output, /event: response\.function_call_arguments\.delta/);
  assert.match(output, /"name":"exec_command"/);
  assert.match(output, /event: response\.completed/);
  assert.ok(output.endsWith("data: [DONE]\n\n"));
});

test("Responses SSE emits the complete lifecycle and terminator", () => {
  let output = "";
  const res = {
    write(value) { output += value; },
    end(value = "") { output += value; },
  };
  const envelope = createResponseEnvelope("chatgpt-web/browser", null);
  const wire = new ResponsesSSE(res, envelope);
  wire.created();
  wire.complete("hello");
  const eventNames = [...output.matchAll(/^event: (.+)$/gm)].map(match => match[1]);
  assert.deepEqual(eventNames, [
    "response.created",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.completed",
  ]);
  assert.match(output, /"delta":"hello"/);
  assert.ok(output.endsWith("data: [DONE]\n\n"));
});
