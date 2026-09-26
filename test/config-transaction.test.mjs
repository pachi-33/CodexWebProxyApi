import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installIntegration, restoreIntegration } from "../src/config-transaction.mjs";

test("install and restore preserve the exact original Codex config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-provider-config-"));
  const codexHome = path.join(root, "codex");
  const stateDir = path.join(root, "state");
  await fs.mkdir(codexHome);
  const configPath = path.join(codexHome, "config.toml");
  const original = 'model = "gpt-native"\n\n[features]\ngoals = true\n';
  await fs.writeFile(configPath, original);
  const health = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"status":"ok"}');
  });
  await new Promise(resolve => health.listen(0, "127.0.0.1", resolve));
  const address = health.address();
  const endpoint = "http://127.0.0.1:" + address.port + "/v1";
  try {
    const result = await installIntegration({ endpoint, codexHome, stateDir });
    assert.equal(result.changed, true);
    const installed = await fs.readFile(configPath, "utf8");
    assert.match(installed, /Managed by codex-chatgpt-web-minimal/);
    assert.match(installed, new RegExp(endpoint.replaceAll("/", "\\/")));
    const restored = await restoreIntegration({ codexHome, stateDir });
    assert.equal(restored.changed, true);
    assert.equal(await fs.readFile(configPath, "utf8"), original);
  } finally {
    await new Promise(resolve => health.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
