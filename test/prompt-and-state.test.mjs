import assert from "node:assert/strict";
import test from "node:test";
import { ContinuationStore } from "../src/continuations.mjs";
import {
  compactConversation,
  compileBrowserPrompt,
  parseBrowserClientResult,
  parseBrowserResult,
  parseResponsesRequest,
} from "../src/prompt-compiler.mjs";

test("compiler preserves instructions, roles, and previous response history", () => {
  const store = new ContinuationStore();
  const firstInput = [{ type: "message", role: "user", content: [{ type: "input_text", text: "alpha" }] }];
  store.remember("resp_previous", firstInput, [{
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "beta" }],
  }]);
  const request = parseResponsesRequest({
    model: "chatgpt-web/browser",
    instructions: "Be concise",
    previous_response_id: "resp_previous",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "repeat" }] }],
  }, store);
  assert.equal(request.expandedInput.length, 3);
  const prompt = compileBrowserPrompt(request).prompt;
  assert.match(prompt, /Be concise/);
  assert.match(prompt, /alpha/);
  assert.match(prompt, /beta/);
  assert.match(prompt, /repeat/);
  assert.match(prompt, /Continue the existing conversation/);
});

test("Responses Lite additional_tools are omitted from conversation text", () => {
  const store = new ContinuationStore();
  const hugeDescription = "tool metadata ".repeat(5000);
  const request = parseResponsesRequest({
    model: "chatgpt-web/browser",
    input: [{
      type: "additional_tools",
      role: "developer",
      tools: [{ type: "function", name: "exec_command", description: hugeDescription, parameters: {} }],
    }, {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    }],
  }, store);
  const prompt = compileBrowserPrompt(request).prompt;
  assert.doesNotMatch(prompt, /additional_tools|tool metadata|exec_command/);
  assert.match(prompt, /hello/);
  assert.ok(prompt.length < 5000);
});

test("Codex runtime context is removed from the visible browser prompt", () => {
  const store = new ContinuationStore();
  const request = parseResponsesRequest({
    model: "chatgpt-web/browser",
    input: [{
      type: "message",
      role: "developer",
      content: [
        { type: "input_text", text: "large host instructions" },
        { type: "input_text", text: "large skill catalog" },
      ],
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: ["generic.developer_instructions", "host_skills.instructions"],
      },
    }, {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "recommended plugins" },
        { type: "input_text", text: "workspace environment" },
      ],
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: ["plugins.recommendations", "environments.environment_context"],
      },
    }, {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
    }],
  }, store);
  const compiled = compileBrowserPrompt(request);
  assert.equal(compiled.prompt, "hi");
  assert.deepEqual(compactConversation(request.expandedInput), [{ role: "user", text: "hi" }]);
});

test("agent mode exposes Responses Lite namespace tools without leaking their transport item", () => {
  const store = new ContinuationStore();
  const request = parseResponsesRequest({
    model: "chatgpt-web/agent",
    tool_choice: "required",
    input: [{
      type: "additional_tools",
      role: "developer",
      tools: [{
        type: "namespace",
        name: "functions",
        tools: [{
          type: "function",
          name: "exec_command",
          description: "Run a command",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
        }],
      }],
    }, { type: "message", role: "user", content: "run pwd" }],
  }, store);
  const compiled = compileBrowserPrompt(request);
  assert.equal(compiled.tools.length, 1);
  assert.equal(compiled.tools[0].name, "exec_command");
  assert.doesNotMatch(compiled.prompt, /additional_tools/);
  assert.match(compiled.prompt, /<available_tools>/);
  assert.match(compiled.prompt, /exec_command/);
});

test("agent model translates only nonce-bound declared tool calls", () => {
  const store = new ContinuationStore();
  const request = parseResponsesRequest({
    model: "chatgpt-web/agent",
    input: "inspect the repo",
    tool_choice: "required",
    tools: [{
      type: "function",
      name: "exec_command",
      description: "Run a command",
      parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
    }],
  }, store);
  const compiled = compileBrowserPrompt(request);
  assert.equal(compiled.mode, "agent");
  assert.match(compiled.prompt, /exec_command/);
  const result = parseBrowserResult(
    "CODEX_PROVIDER_RESULT_" + compiled.nonce + "\n" + JSON.stringify({
      nonce: compiled.nonce,
      kind: "tool_calls",
      calls: [{ tool: "t0", arguments: { cmd: "pwd" } }],
    }),
    compiled,
  );
  assert.equal(result.kind, "tool_calls");
  assert.equal(result.calls[0].name, "exec_command");
  assert.equal(result.calls[0].arguments, '{"cmd":"pwd"}');
  assert.throws(() => parseBrowserResult(
    'CODEX_PROVIDER_RESULT_wrong\n{"nonce":"wrong","kind":"tool_calls","calls":[]}',
    compiled,
  ), error => error.code === "invalid_agent_envelope");
});

test("agent envelope is parsed from raw browser text before Markdown escaping", () => {
  const store = new ContinuationStore();
  const request = parseResponsesRequest({
    model: "chatgpt-web/agent",
    input: "inspect the repo",
    tool_choice: "required",
    tools: [{
      type: "function",
      name: "exec_command",
      description: "Run a command",
      parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
    }],
  }, store);
  const compiled = compileBrowserPrompt(request);
  const text = "CODEX_PROVIDER_RESULT_" + compiled.nonce + "\n" + JSON.stringify({
    nonce: compiled.nonce,
    kind: "tool_calls",
    calls: [{ tool: "t0", arguments: { cmd: "pwd" } }],
  });
  const markdown = text.replaceAll("_", "\\_");
  assert.throws(
    () => parseBrowserResult(markdown, compiled),
    error => error.code === "invalid_agent_envelope",
  );
  const result = parseBrowserClientResult({ text, markdown }, compiled);
  assert.equal(result.kind, "tool_calls");
  assert.equal(result.calls[0].name, "exec_command");
  assert.equal(result.calls[0].arguments, '{"cmd":"pwd"}');
});

test("tool continuation reuses its browser session and sends only the new tool output", () => {
  const store = new ContinuationStore();
  const tools = [{
    type: "function",
    name: "exec_command",
    description: "Run a command. " + "Long host-only documentation. ".repeat(100),
    parameters: {
      type: "object",
      properties: { cmd: { type: "string", description: "Shell command to execute." } },
      required: ["cmd"],
    },
  }];
  const hostInstructions = [
    "You are Codex, an agent based on GPT-6.",
    "# Working with the user",
    "host runtime details",
    "# Rules for getting work done",
  ].join("\n");
  const first = parseResponsesRequest({
    model: "chatgpt-web/agent",
    instructions: hostInstructions,
    input: [{ type: "message", role: "user", content: "inspect this repository" }],
    tools,
  }, store);
  const firstCompiled = compileBrowserPrompt(first);
  assert.doesNotMatch(firstCompiled.prompt, /You are Codex, an agent based on/);
  assert.doesNotMatch(firstCompiled.prompt, /Shell command to execute/);
  assert.ok(firstCompiled.prompt.length < 2500);

  const call = {
    type: "function_call",
    call_id: "call_continue",
    name: "exec_command",
    arguments: '{"cmd":"pwd"}',
  };
  store.remember("resp_first", first.expandedInput, [call], { browserSessionId: "browser-session-a" });
  const second = parseResponsesRequest({
    model: "chatgpt-web/agent",
    instructions: hostInstructions,
    input: [
      { type: "message", role: "developer", content: hostInstructions },
      { type: "message", role: "user", content: "inspect this repository" },
      call,
      { type: "function_call_output", call_id: call.call_id, output: "repo-file.txt" },
    ],
    tools,
  }, store);
  assert.equal(second.browserSessionId, "browser-session-a");
  const secondCompiled = compileBrowserPrompt(second);
  assert.match(secondCompiled.prompt, /repo-file\.txt/);
  assert.doesNotMatch(secondCompiled.prompt, /inspect this repository|available_tools|You are Codex/);
  assert.match(secondCompiled.recoveryPrompt, /inspect this repository|available_tools/);
  assert.doesNotMatch(secondCompiled.recoveryPrompt, /host runtime details/);
});

test("unknown previous_response_id fails closed", () => {
  const store = new ContinuationStore();
  assert.throws(() => parseResponsesRequest({
    model: "chatgpt-web/browser",
    previous_response_id: "missing",
    input: "next",
  }, store), error => error.code === "continuation_state_unavailable");
});

test("browser-only required tools and structured output fail explicitly", () => {
  const store = new ContinuationStore();
  assert.throws(() => parseResponsesRequest({
    model: "chatgpt-web/browser",
    input: "run shell",
    tool_choice: "required",
  }, store), error => error.code === "tools_unsupported");
  assert.throws(() => parseResponsesRequest({
    model: "chatgpt-web/browser",
    input: "json",
    text: { format: { type: "json_schema" } },
  }, store), error => error.code === "structured_output_unsupported");
});
