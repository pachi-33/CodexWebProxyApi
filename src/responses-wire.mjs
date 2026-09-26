import crypto from "node:crypto";

function id(prefix) {
  return prefix + "_" + crypto.randomUUID().replaceAll("-", "");
}

export function createResponseEnvelope(model, previousResponseId = null) {
  return {
    id: id("resp"),
    messageId: id("msg"),
    createdAt: Math.floor(Date.now() / 1000),
    model,
    previousResponseId,
  };
}

export function messageItem(envelope, text, status = "completed") {
  return {
    id: envelope.messageId,
    type: "message",
    status,
    role: "assistant",
    content: status === "completed" ? [{ type: "output_text", text, annotations: [] }] : [],
  };
}

export function completedResponse(envelope, text) {
  return completedResponseFromOutput(envelope, [messageItem(envelope, text)]);
}

export function completedResponseFromOutput(envelope, output) {
  return {
    id: envelope.id,
    object: "response",
    created_at: envelope.createdAt,
    status: "completed",
    model: envelope.model,
    previous_response_id: envelope.previousResponseId,
    output,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

export function resultToOutput(envelope, result) {
  if (result.kind === "final") return [messageItem(envelope, result.text)];
  return result.calls.map(call => {
    const common = {
      id: id(call.type === "custom" ? "ctc" : "fc"),
      call_id: id("call"),
      name: call.name,
      status: "completed",
    };
    if (call.type === "custom") {
      return { type: "custom_tool_call", ...common, input: call.input };
    }
    return {
      type: "function_call",
      ...common,
      arguments: call.arguments,
      ...(call.namespace ? { namespace: call.namespace } : {}),
    };
  });
}

export class ResponsesSSE {
  constructor(res, envelope) {
    this.res = res;
    this.envelope = envelope;
    this.sequence = 0;
  }

  event(name, data) {
    const payload = { type: name, sequence_number: this.sequence++, ...data };
    this.res.write("event: " + name + "\n" + "data: " + JSON.stringify(payload) + "\n\n");
  }

  created() {
    this.event("response.created", {
      response: {
        id: this.envelope.id,
        object: "response",
        created_at: this.envelope.createdAt,
        status: "in_progress",
        model: this.envelope.model,
        previous_response_id: this.envelope.previousResponseId,
        output: [],
        usage: null,
      },
    });
  }

  heartbeat() {
    this.event("response.heartbeat", {});
  }

  complete(text) {
    return this.completeOutput([messageItem(this.envelope, text)]);
  }

  completeOutput(output) {
    output.forEach((item, outputIndex) => {
      if (item.type === "function_call") {
        const pending = { ...item, arguments: "", status: "in_progress" };
        this.event("response.output_item.added", { output_index: outputIndex, item: pending });
        this.event("response.function_call_arguments.delta", {
          item_id: item.id,
          output_index: outputIndex,
          delta: item.arguments,
        });
        this.event("response.function_call_arguments.done", {
          item_id: item.id,
          output_index: outputIndex,
          arguments: item.arguments,
        });
        this.event("response.output_item.done", { output_index: outputIndex, item });
        return;
      }
      if (item.type === "custom_tool_call") {
        const pending = { ...item, input: "", status: "in_progress" };
        this.event("response.output_item.added", { output_index: outputIndex, item: pending });
        this.event("response.custom_tool_call_input.delta", {
          item_id: item.id,
          output_index: outputIndex,
          delta: item.input,
        });
        this.event("response.custom_tool_call_input.done", {
          item_id: item.id,
          output_index: outputIndex,
          input: item.input,
        });
        this.event("response.output_item.done", { output_index: outputIndex, item });
        return;
      }
      this.emitMessage(item, outputIndex);
    });
    this.event("response.completed", { response: completedResponseFromOutput(this.envelope, output) });
    this.res.end("data: [DONE]\n\n");
  }

  emitMessage(item, outputIndex) {
    const text = item.content[0].text;
    const pending = messageItem(this.envelope, "", "in_progress");
    pending.id = item.id;
    this.event("response.output_item.added", { output_index: outputIndex, item: pending });
    this.event("response.content_part.added", {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    for (const delta of chunkText(text, 8192)) {
      this.event("response.output_text.delta", {
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        delta,
      });
    }
    this.event("response.output_text.done", {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      text,
    });
    const part = { type: "output_text", text, annotations: [] };
    this.event("response.content_part.done", {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      part,
    });
    this.event("response.output_item.done", { output_index: outputIndex, item });
  }

  fail(error) {
    const response = {
      id: this.envelope.id,
      object: "response",
      created_at: this.envelope.createdAt,
      status: "failed",
      model: this.envelope.model,
      previous_response_id: this.envelope.previousResponseId,
      output: [],
      error: {
        type: error.type || "server_error",
        code: error.code || "server_error",
        message: error.message || String(error),
      },
    };
    this.event("response.failed", { response });
    this.res.end("data: [DONE]\n\n");
  }
}

export function chunkText(text, size) {
  const chunks = [];
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
  return chunks.length ? chunks : [""];
}
