import assert from "node:assert/strict";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import { createProviderServer } from "../src/http-server.mjs";

class FakeBrowser {
  constructor() {
    this.prompts = [];
    this.options = [];
  }
  async run(prompt, options = {}) {
    this.prompts.push(prompt);
    this.options.push(options);
    const nonce = /CODEX_PROVIDER_RESULT_([0-9a-f]+)/.exec(prompt)?.[1];
    if (nonce) {
      const payload = prompt.includes('role="tool"')
        ? { nonce, kind: "final", text: "DONE AFTER TOOL" }
        : {
            nonce,
            kind: "tool_calls",
            calls: [{ tool: "t0", arguments: { cmd: "pwd" } }],
          };
      const text = "CODEX_PROVIDER_RESULT_" + nonce + "\n" + JSON.stringify(payload);
      return {
        text,
        markdown: text.replaceAll("_", "\\_"),
        identity: "fake-agent",
      };
    }
    return { markdown: "WEB ANSWER " + this.prompts.length, identity: "fake" };
  }
  async close() {}
}

async function fixture() {
  const browser = new FakeBrowser();
  const provider = createProviderServer({
    port: 0,
    browserClient: browser,
    fetchImpl: async request => {
      const url = typeof request === "string" ? request : request.url;
      assert.match(url, /chatgpt\.com\/backend-api\/codex\/models/);
      return Response.json({ models: [{ slug: "native", display_name: "Native", supported_in_api: true }] });
    },
  });
  const address = await provider.listen();
  return { browser, provider, base: address.baseUrl };
}

test("non-stream web response and continuation are transparent Responses JSON", async () => {
  const { browser, provider, base } = await fixture();
  try {
    const first = await fetch(base + "/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/browser", input: "first", stream: false }),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.object, "response");
    assert.equal(firstBody.output[0].content[0].text, "WEB ANSWER 1");

    const second = await fetch(base + "/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/browser",
        input: "second",
        stream: false,
        previous_response_id: firstBody.id,
      }),
    });
    assert.equal(second.status, 200);
    assert.equal(browser.prompts[1], "second");
    assert.match(browser.options[1].recoveryPrompt, /WEB ANSWER 1/);
    assert.match(browser.options[1].recoveryPrompt, /second/);
    assert.equal(browser.options[1].conversationId, browser.options[0].conversationId);
    assert.equal(browser.options[1].continuation, true);
  } finally {
    await provider.close();
  }
});

test("Codex zstd-compressed Responses JSON reaches the browser route", async () => {
  const { browser, provider, base } = await fixture();
  try {
    const encoded = zstdCompressSync(Buffer.from(JSON.stringify({
      model: "chatgpt-web/browser",
      input: "compressed hello",
      stream: false,
    })));
    const response = await fetch(base + "/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "zstd",
      },
      body: encoded,
    });
    assert.equal(response.status, 200);
    assert.match(browser.prompts[0], /compressed hello/);
    assert.equal((await response.json()).output[0].content[0].text, "WEB ANSWER 1");
  } finally {
    await provider.close();
  }
});

test("native passthrough preserves the original zstd bytes and encoding", async () => {
  const encoded = zstdCompressSync(Buffer.from(JSON.stringify({
    model: "native",
    input: "native compressed hello",
    stream: false,
  })));
  let forwarded;
  const provider = createProviderServer({
    port: 0,
    browserClient: new FakeBrowser(),
    fetchImpl: async (url, init) => {
      forwarded = {
        url,
        headers: new Headers(init.headers),
        body: Buffer.from(init.body),
      };
      return Response.json({ id: "native_response", object: "response", status: "completed", output: [] });
    },
  });
  const address = await provider.listen();
  try {
    const response = await fetch(address.baseUrl + "/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
        "content-encoding": "zstd",
      },
      body: encoded,
    });
    assert.equal(response.status, 200);
    assert.match(forwarded.url, /chatgpt\.com\/backend-api\/codex\/responses$/);
    assert.equal(forwarded.headers.get("content-encoding"), "zstd");
    assert.deepEqual(forwarded.body, encoded);
  } finally {
    await provider.close();
  }
});

test("agent route translates browser protocol into a Responses function_call", async () => {
  const { provider, base } = await fixture();
  try {
    const response = await fetch(base + "/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/agent",
        input: "where am I",
        stream: false,
        tool_choice: "required",
        tools: [{
          type: "function",
          name: "exec_command",
          description: "Run command",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
        }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.output[0].type, "function_call");
    assert.equal(body.output[0].name, "exec_command");
    assert.equal(body.output[0].arguments, '{"cmd":"pwd"}');
  } finally {
    await provider.close();
  }
});

test("agent tool output continues in one browser session with a delta prompt", async () => {
  const { browser, provider, base } = await fixture();
  const hostInstructions = [
    "You are Codex, an agent based on GPT-6.",
    "# Working with the user",
    "host runtime details",
    "# Rules for getting work done",
  ].join("\n");
  const tools = [{
    type: "function",
    name: "exec_command",
    description: "Run command",
    parameters: { type: "object", properties: { cmd: { type: "string" } } },
  }];
  try {
    const firstResponse = await fetch(base + "/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/agent",
        instructions: hostInstructions,
        input: [{ type: "message", role: "user", content: "inspect the repo" }],
        tools,
        stream: false,
      }),
    });
    const first = await firstResponse.json();
    const call = first.output[0];
    assert.equal(call.type, "function_call");
    assert.match(browser.options[0].agentNonce, /^[0-9a-f]{24}$/);

    const secondResponse = await fetch(base + "/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/agent",
        instructions: hostInstructions,
        input: [
          { type: "message", role: "developer", content: hostInstructions },
          { type: "message", role: "user", content: "inspect the repo" },
          call,
          { type: "function_call_output", call_id: call.call_id, output: "repo-file.txt" },
        ],
        tools,
        stream: false,
      }),
    });
    const second = await secondResponse.json();
    assert.equal(second.output[0].content[0].text, "DONE AFTER TOOL");
    assert.equal(browser.options[1].conversationId, browser.options[0].conversationId);
    assert.equal(browser.options[1].continuation, true);
    assert.match(browser.options[1].agentNonce, /^[0-9a-f]{24}$/);
    assert.match(browser.prompts[1], /repo-file\.txt/);
    assert.doesNotMatch(browser.prompts[1], /inspect the repo|available_tools|host runtime details/);
    assert.match(browser.options[1].recoveryPrompt, /inspect the repo|available_tools/);
  } finally {
    await provider.close();
  }
});

test("streaming response uses Responses SSE and models preserve native catalog", async () => {
  const { provider, base } = await fixture();
  try {
    const models = await fetch(base + "/v1/models?client_version=1.2.3", {
      headers: { authorization: "Bearer test-token" },
    });
    assert.equal(models.status, 200);
    assert.deepEqual((await models.json()).models.map(model => model.slug), ["native", "chatgpt-web/browser", "chatgpt-web/agent"]);

    const response = await fetch(base + "/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/browser", input: "stream me", stream: true }),
    });
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const body = await response.text();
    assert.match(body, /event: response\.created/);
    assert.match(body, /event: response\.completed/);
    assert.ok(body.endsWith("data: [DONE]\n\n"));
  } finally {
    await provider.close();
  }
});

test("model catalog works without authorization and does not call the native backend", async () => {
  const browser = new FakeBrowser();
  let nativeFetches = 0;
  const provider = createProviderServer({
    port: 0,
    browserClient: browser,
    fetchImpl: async () => {
      nativeFetches += 1;
      throw new Error("native backend must not be called for an unauthenticated catalog");
    },
  });
  const address = await provider.listen();
  try {
    const response = await fetch(address.baseUrl + "/v1/models");
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).models.map(model => model.slug), [
      "chatgpt-web/browser",
      "chatgpt-web/agent",
    ]);
    assert.equal(nativeFetches, 0);
  } finally {
    await provider.close();
  }
});

test("web responses work without authorization while native passthrough still requires it", async () => {
  const { provider, base } = await fixture();
  try {
    const webResponse = await fetch(base + "/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/browser", input: "no key", stream: false }),
    });
    assert.equal(webResponse.status, 200);

    const nativeResponse = await fetch(base + "/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "native", input: "no key", stream: false }),
    });
    assert.equal(nativeResponse.status, 401);
    assert.equal((await nativeResponse.json()).error.code, "missing_authorization");
  } finally {
    await provider.close();
  }
});
