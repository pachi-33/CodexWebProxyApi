import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { ExtensionBrowserClient } from "../src/extension-browser-client.mjs";

test("normal Chrome extension transport accepts only extension-origin bridge results", async () => {
  const client = new ExtensionBrowserClient({ port: 0, timeoutMs: 5000 });
  await client.start();
  const socket = new WebSocket("ws://127.0.0.1:" + client.port, {
    origin: "chrome-extension://unit-test-extension",
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, extensionVersion: "0.1.1" }));
  let observedRun;
  socket.on("message", data => {
    const message = JSON.parse(data.toString());
    if (message.type !== "run") return;
    observedRun = message;
    socket.send(JSON.stringify({
      type: "result",
      id: message.id,
      ok: true,
      html: "<p>Normal <strong>Chrome</strong> response</p>",
      text: "Normal Chrome response",
      identity: "test-turn",
      url: "https://chatgpt.com/?temporary-chat=true",
    }));
  });
  try {
    const result = await client.run("hello", {
      conversationId: "conversation-test",
      continuation: true,
      recoveryPrompt: "full recovery prompt",
      agentNonce: "nonce-test",
    });
    assert.equal(result.markdown, "Normal **Chrome** response");
    assert.equal(result.text, "Normal Chrome response");
    assert.equal(result.transport, "extension");
    assert.equal(observedRun.conversationId, "conversation-test");
    assert.equal(observedRun.continuation, true);
    assert.equal(observedRun.recoveryPrompt, "full recovery prompt");
    assert.equal(observedRun.agentNonce, "nonce-test");
    assert.equal(client.status().extension_connected, true);
    assert.equal(client.status().extension_version, "0.1.1");
  } finally {
    socket.close();
    await client.close();
  }
});
