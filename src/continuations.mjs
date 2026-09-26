import { ProviderError } from "./errors.mjs";

export class ContinuationStore {
  constructor(options = {}) {
    this.ttlMs = options.ttlMs || 60 * 60 * 1000;
    this.maxEntries = options.maxEntries || 128;
    this.maxBytes = options.maxBytes || 16 * 1024 * 1024;
    this.entries = new Map();
    this.callSessions = new Map();
    this.bytes = 0;
  }

  prune(now = Date.now()) {
    for (const [id, entry] of this.entries) {
      if (now - entry.createdAt > this.ttlMs) this.delete(id);
    }
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.delete(oldest);
    }
  }

  delete(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    for (const callId of entry.callIds || []) {
      if (this.callSessions.get(callId)?.responseId === id) this.callSessions.delete(callId);
    }
    this.bytes -= entry.bytes;
  }

  expand(previousResponseId, input) {
    this.prune();
    if (!previousResponseId) return normalizeInput(input);
    const entry = this.entries.get(previousResponseId);
    if (!entry) {
      throw new ProviderError("previous_response_id is unknown or expired", {
        status: 409,
        type: "invalid_request_error",
        code: "continuation_state_unavailable",
      });
    }
    return structuredClone([...entry.items, ...normalizeInput(input)]);
  }

  browserSessionFor(previousResponseId, input) {
    if (previousResponseId) {
      const entry = this.entries.get(previousResponseId);
      if (entry?.browserSessionId) return entry.browserSessionId;
    }
    const items = normalizeInput(input);
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (!item || (item.type !== "function_call_output" && item.type !== "custom_tool_call_output")) continue;
      const linked = this.callSessions.get(String(item.call_id || ""));
      if (linked?.browserSessionId) return linked.browserSessionId;
    }
    return null;
  }

  remember(responseId, expandedInput, output, options = {}) {
    const items = structuredClone([...expandedInput, ...output]);
    const bytes = Buffer.byteLength(JSON.stringify(items));
    if (bytes > this.maxBytes) {
      throw new ProviderError("Conversation state exceeds the local continuation limit", {
        status: 413,
        type: "invalid_request_error",
        code: "context_length_exceeded",
      });
    }
    const callIds = output
      .filter(item => item?.type === "function_call" || item?.type === "custom_tool_call")
      .map(item => String(item.call_id || ""))
      .filter(Boolean);
    const browserSessionId = options.browserSessionId || null;
    this.entries.set(responseId, { createdAt: Date.now(), items, bytes, browserSessionId, callIds });
    for (const callId of callIds) {
      this.callSessions.set(callId, { responseId, browserSessionId });
    }
    this.bytes += bytes;
    this.prune();
  }
}

export function normalizeInput(input) {
  if (typeof input === "string") {
    return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
  }
  if (!Array.isArray(input)) {
    throw new ProviderError("input must be a string or an array", {
      status: 400,
      type: "invalid_request_error",
      code: "invalid_input",
    });
  }
  return structuredClone(input);
}
