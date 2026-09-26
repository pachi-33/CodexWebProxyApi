import crypto from "node:crypto";
import { normalizeInput } from "./continuations.mjs";
import { ProviderError } from "./errors.mjs";
import { WEB_AGENT_MODEL, WEB_MODEL_PREFIX } from "./constants.mjs";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseResponsesRequest(value, continuations) {
  if (!isObject(value)) {
    throw new ProviderError("Request body must be a JSON object", { status: 400, type: "invalid_request_error" });
  }
  if (typeof value.model !== "string" || !value.model.startsWith(WEB_MODEL_PREFIX)) {
    throw new ProviderError("A chatgpt-web model is required", { status: 400, type: "invalid_request_error" });
  }
  const agentMode = value.model === WEB_AGENT_MODEL;
  if (!agentMode && (value.tool_choice === "required" || isObject(value.tool_choice))) {
    throw new ProviderError("Required tool calls are unavailable in browser-only mode", {
      status: 400,
      type: "invalid_request_error",
      code: "tools_unsupported",
    });
  }
  if (value.text && isObject(value.text) && value.text.format && value.text.format.type !== "text") {
    throw new ProviderError("Structured text formats are not supported yet", {
      status: 400,
      type: "invalid_request_error",
      code: "structured_output_unsupported",
    });
  }
  const previousResponseId = value.previous_response_id == null ? null : String(value.previous_response_id);
  const input = normalizeInput(value.input);
  const expandedInput = continuations.expand(previousResponseId, input);
  const browserSessionId = continuations.browserSessionFor(previousResponseId, input);
  return {
    raw: value,
    model: value.model,
    stream: value.stream !== false,
    instructions: typeof value.instructions === "string" ? value.instructions : "",
    previousResponseId,
    input,
    expandedInput,
    browserSessionId,
    agentMode,
  };
}

export function compileBrowserPrompt(request) {
  const nonce = crypto.randomBytes(12).toString("hex");
  const continuing = Boolean(request.browserSessionId);
  const fullConversation = compactConversation(request.expandedInput);
  const conversation = continuing
    ? compactContinuation(request.input, request.expandedInput)
    : fullConversation;
  const instructions = publicInstructions(request.instructions);
  const tools = request.agentMode
    ? compileTools(mergeToolSpecs(request.raw.tools, request.expandedInput))
    : [];
  if (request.agentMode && (request.raw.tool_choice === "required" || isObject(request.raw.tool_choice)) && tools.length === 0) {
    throw new ProviderError("tool_choice requires at least one supported function or custom tool", {
      status: 400,
      type: "invalid_request_error",
      code: "tools_unsupported",
    });
  }
  if (conversation.length === 0 && !instructions) {
    throw new ProviderError("No user-visible text remains after removing Codex runtime context", {
      status: 400,
      type: "invalid_request_error",
      code: "empty_browser_input",
    });
  }

  const prompt = renderBrowserPrompt({
    agentMode: request.agentMode,
    continuation: continuing,
    conversation,
    instructions: continuing ? "" : instructions,
    tools,
    includeTools: !continuing,
    nonce,
  });
  const recoveryPrompt = continuing
    ? renderBrowserPrompt({
        agentMode: request.agentMode,
        continuation: false,
        conversation: fullConversation,
        instructions,
        tools,
        includeTools: true,
        nonce,
      })
    : prompt;
  return {
    prompt,
    recoveryPrompt,
    mode: request.agentMode ? "agent" : "browser",
    nonce,
    tools,
    toolChoiceRequired: request.raw.tool_choice === "required" || isObject(request.raw.tool_choice),
  };
}

const INTERNAL_CONTENT_KINDS = new Set([
  "generic.developer_instructions",
  "host_skills.instructions",
  "permissions.instructions",
  "collaboration_mode.instructions",
  "plugins.recommendations",
  "environments.environment_context",
  "browser.ambient_ui_state",
  "apps.instructions",
]);

const INTERNAL_TEXT_MARKERS = [
  "<app-context>",
  "<skills_instructions>",
  "<permissions instructions>",
  "<collaboration_mode>",
  "<recommended_plugins>",
  "<environment_context>",
  "<apps_instructions>",
  "<plugins_instructions>",
];

function isInternalHostText(text, role) {
  const trimmed = text.trim();
  if (INTERNAL_TEXT_MARKERS.some(marker => trimmed.includes(marker))) return true;
  return (role === "system" || role === "developer")
    && trimmed.includes("You are Codex, an agent based on")
    && trimmed.includes("# Working with the user")
    && trimmed.includes("# Rules for getting work done");
}

function publicInstructions(value) {
  const text = String(value || "").trim();
  return text && !isInternalHostText(text, "developer") ? text : "";
}

function partText(part) {
  if (typeof part === "string") return part;
  if (!isObject(part)) return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.output_text === "string") return part.output_text;
  return "";
}

function compactMessage(item) {
  const role = ["system", "developer", "user", "assistant"].includes(item.role)
    ? item.role
    : "user";
  if (typeof item.content === "string") {
    const text = item.content.trim();
    return text && !isInternalHostText(text, role) ? { role, text } : null;
  }
  if (!Array.isArray(item.content)) return null;
  const kinds = item.internal_chat_message_metadata_passthrough?.content_item_kinds;
  const texts = item.content.flatMap((part, index) => {
    const kind = Array.isArray(kinds) ? kinds[index] : null;
    if (typeof kind === "string" && INTERNAL_CONTENT_KINDS.has(kind)) return [];
    const text = partText(part).trim();
    return text && !isInternalHostText(text, role) ? [text] : [];
  });
  return texts.length ? { role, text: texts.join("\n\n") } : null;
}

export function compactConversation(input) {
  const rows = [];
  for (const item of Array.isArray(input) ? input : []) {
    if (!isObject(item) || item.type === "additional_tools" || item.type === "reasoning") continue;
    if (item.type === "message") {
      const message = compactMessage(item);
      if (message) rows.push(message);
      continue;
    }
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const payload = item.type === "function_call" ? item.arguments : item.input;
      rows.push({
        role: "assistant_tool_call",
        text: String(item.name || "tool") + " " + String(payload || ""),
      });
      continue;
    }
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? null);
      rows.push({ role: "tool", text: output });
    }
  }
  return rows;
}

export function compactContinuation(input, expandedInput = input) {
  const source = Array.isArray(input) ? input : [];
  const callNames = new Map();
  for (const item of Array.isArray(expandedInput) ? expandedInput : []) {
    if (!isObject(item) || (item.type !== "function_call" && item.type !== "custom_tool_call")) continue;
    if (item.call_id) callNames.set(String(item.call_id), String(item.name || "tool"));
  }
  let lastCallIndex = -1;
  for (let index = source.length - 1; index >= 0; index -= 1) {
    if (source[index]?.type === "function_call" || source[index]?.type === "custom_tool_call") {
      lastCallIndex = index;
      break;
    }
  }
  const outputs = source.slice(lastCallIndex + 1).filter(item => (
    isObject(item)
    && (item.type === "function_call_output" || item.type === "custom_tool_call_output")
  ));
  if (outputs.length) {
    return outputs.map(item => {
      const callId = String(item.call_id || "");
      const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? null);
      return {
        role: "tool",
        text: JSON.stringify({ call_id: callId, tool: callNames.get(callId) || "tool", output }),
      };
    });
  }
  const compacted = compactConversation(source);
  return compacted.length ? [compacted.at(-1)] : [];
}

function renderBrowserPrompt(options) {
  const { agentMode, continuation, conversation, instructions, tools, includeTools, nonce } = options;
  if (!agentMode && !instructions && conversation.length === 1 && conversation[0].role === "user") {
    return conversation[0].text;
  }
  const lines = [];
  if (agentMode) {
    lines.push(continuation
      ? "Continue the existing Codex task using only the new tool result below."
      : "Act as the model backend for this Codex request. Do not claim that you executed local tools yourself.");
  } else {
    lines.push("Continue the existing conversation and answer the latest user message directly.");
  }
  if (instructions) lines.push("<developer_instructions>", instructions, "</developer_instructions>");
  lines.push(renderConversation(conversation));
  if (agentMode && includeTools) {
    lines.push("<available_tools>", JSON.stringify(tools.map(tool => tool.prompt)), "</available_tools>");
  }
  if (agentMode) {
    lines.push(
      "You may request the outer Codex runtime to execute only the tools already provided in this ChatGPT conversation; you never execute them yourself.",
      "Choose one result: a final answer, or one or more tool calls needed before continuing.",
      "Return exactly the marker on one line followed by exactly one JSON object and no other text:",
      "CODEX_PROVIDER_RESULT_" + nonce,
      '{"nonce":"' + nonce + '","kind":"final","text":"Markdown answer"}',
      "or",
      '{"nonce":"' + nonce + '","kind":"tool_calls","calls":[{"tool":"t0","arguments":{}}]}',
      "For a custom tool use the string field input instead of arguments. Never invent a tool key.",
    );
  }
  return lines.filter(Boolean).join("\n");
}

function renderConversation(conversation) {
  if (conversation.length === 1 && conversation[0].role === "user") return conversation[0].text;
  return conversation.map(item => (
    "<message role=\"" + item.role + "\">\n" + item.text + "\n</message>"
  )).join("\n\n");
}

function mergeToolSpecs(declared, input) {
  if (declared != null && !Array.isArray(declared)) {
    throw new ProviderError("tools must be an array", {
      status: 400,
      type: "invalid_request_error",
      code: "invalid_tools",
    });
  }
  const merged = [...(declared || [])];
  if (Array.isArray(input)) {
    for (const item of input) {
      if (isObject(item) && item.type === "additional_tools" && Array.isArray(item.tools)) {
        merged.push(...item.tools);
      }
    }
  }
  return merged;
}

function compactDescription(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function compactSchema(value, key = "") {
  if (Array.isArray(value)) return value.map(item => compactSchema(item));
  if (!isObject(value)) return value;
  const omitted = new Set(["description", "title", "examples", "default", "$comment"]);
  return Object.fromEntries(Object.entries(value)
    .filter(([childKey]) => !omitted.has(childKey))
    .map(([childKey, childValue]) => [childKey, compactSchema(childValue, childKey)]));
}

function compileTools(value) {
  if (!Array.isArray(value)) {
    throw new ProviderError("tools must be an array", {
      status: 400,
      type: "invalid_request_error",
      code: "invalid_tools",
    });
  }
  const tools = [];
  const seen = new Set();
  const pushTool = (raw, namespace) => {
    if (!isObject(raw) || typeof raw.name !== "string") return;
    if (raw.type !== "function" && raw.type !== "custom") return;
    if (raw.type === "custom" && namespace) return;
    const identity = raw.type + ":" + (namespace || "") + ":" + raw.name;
    if (seen.has(identity)) return;
    seen.add(identity);
    const key = "t" + tools.length;
    const tool = {
      key,
      type: raw.type,
      name: raw.name,
      namespace: namespace || (typeof raw.namespace === "string" ? raw.namespace : undefined),
      prompt: {
        key,
        type: raw.type,
        name: raw.name,
        namespace: namespace || (typeof raw.namespace === "string" ? raw.namespace : null),
        description: compactDescription(raw.description),
        input_schema: compactSchema(raw.type === "function" ? (raw.parameters || {}) : (raw.format || null)),
      },
    };
    tools.push(tool);
  };
  for (const raw of value) {
    if (!isObject(raw)) continue;
    if (raw.type === "namespace" && typeof raw.name === "string" && Array.isArray(raw.tools)) {
      const namespace = raw.name === "functions" ? undefined : raw.name;
      for (const inner of raw.tools) pushTool(inner, namespace);
      continue;
    }
    pushTool(raw, undefined);
  }
  if (tools.length > 256) {
    throw new ProviderError("Too many tools for the browser transport", {
      status: 413,
      type: "invalid_request_error",
      code: "too_many_tools",
    });
  }
  return tools;
}

function extractJsonAfterMarker(markdown, marker) {
  const markerIndex = markdown.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const tail = markdown.slice(markerIndex + marker.length);
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

export function parseBrowserResult(markdown, compiled) {
  if (compiled.mode === "browser") return { kind: "final", text: markdown };
  const marker = "CODEX_PROVIDER_RESULT_" + compiled.nonce;
  const jsonText = extractJsonAfterMarker(markdown, marker);
  if (!jsonText) {
    throw new ProviderError("ChatGPT did not return the required agent result envelope", {
      status: 502,
      code: "invalid_agent_envelope",
    });
  }
  let payload;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    throw new ProviderError("ChatGPT returned invalid JSON in the agent result envelope", {
      status: 502,
      code: "invalid_agent_json",
    });
  }
  if (!isObject(payload) || payload.nonce !== compiled.nonce) {
    throw new ProviderError("ChatGPT agent result nonce did not match this request", {
      status: 502,
      code: "agent_nonce_mismatch",
    });
  }
  if (payload.kind === "final" && typeof payload.text === "string") {
    if (compiled.toolChoiceRequired) {
      throw new ProviderError("The model returned a final answer while tool_choice required a tool", {
        status: 502,
        code: "required_tool_not_called",
      });
    }
    return { kind: "final", text: payload.text };
  }
  if (payload.kind !== "tool_calls" || !Array.isArray(payload.calls) || payload.calls.length < 1 || payload.calls.length > 8) {
    throw new ProviderError("ChatGPT returned an invalid agent result kind or call list", {
      status: 502,
      code: "invalid_agent_result",
    });
  }
  const byKey = new Map(compiled.tools.map(tool => [tool.key, tool]));
  const calls = payload.calls.map(call => {
    if (!isObject(call) || typeof call.tool !== "string" || !byKey.has(call.tool)) {
      throw new ProviderError("ChatGPT requested an unknown tool key", {
        status: 502,
        code: "unknown_tool_key",
      });
    }
    const tool = byKey.get(call.tool);
    if (tool.type === "custom") {
      if (typeof call.input !== "string") {
        throw new ProviderError("Custom tool input must be a string", { status: 502, code: "invalid_tool_arguments" });
      }
      return { ...tool, input: call.input };
    }
    const argumentsValue = call.arguments == null ? {} : call.arguments;
    const argumentsJson = typeof argumentsValue === "string" ? argumentsValue : JSON.stringify(argumentsValue);
    try {
      const parsed = JSON.parse(argumentsJson);
      if (!isObject(parsed)) throw new Error();
    } catch {
      throw new ProviderError("Function tool arguments must encode a JSON object", {
        status: 502,
        code: "invalid_tool_arguments",
      });
    }
    return { ...tool, arguments: argumentsJson };
  });
  return { kind: "tool_calls", calls };
}

export function parseBrowserClientResult(result, compiled) {
  const source = compiled.mode === "agent" && typeof result.text === "string" && result.text.trim()
    ? result.text
    : result.markdown;
  try {
    return parseBrowserResult(source, compiled);
  } catch (error) {
    if (compiled.mode === "agent" && error?.code === "invalid_agent_envelope") {
      const marker = "CODEX_PROVIDER_RESULT_" + compiled.nonce;
      const observed = String(source || "").match(/CODEX\\?_PROVIDER\\?_RESULT\\?_([0-9a-f]+)/i)?.[1] || null;
      console.error("Agent envelope mismatch", JSON.stringify({
        expected_nonce: compiled.nonce,
        observed_nonce: observed,
        raw_text_chars: typeof result.text === "string" ? result.text.length : null,
        markdown_chars: typeof result.markdown === "string" ? result.markdown.length : null,
        raw_has_expected_marker: typeof result.text === "string" && result.text.includes(marker),
        markdown_has_expected_marker: typeof result.markdown === "string" && result.markdown.includes(marker),
      }));
    }
    throw error;
  }
}
