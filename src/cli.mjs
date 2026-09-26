#!/usr/bin/env node

import readline from "node:readline/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { BrowserClient, openLoginBrowser } from "./browser-client.mjs";
import { installIntegration, integrationStatus, restoreIntegration } from "./config-transaction.mjs";
import { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_PROFILE_DIR } from "./constants.mjs";
import { DEFAULT_EXTENSION_PORT, ExtensionBrowserClient } from "./extension-browser-client.mjs";
import { createProviderServer } from "./http-server.mjs";

const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../chrome-extension");

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (rest[index + 1] && !rest[index + 1].startsWith("--")) flags[key] = rest[++index];
    else flags[key] = true;
  }
  return { command, flags };
}

function numberFlag(value, fallback) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error("Invalid port: " + value);
  return parsed;
}

function browserOptions(flags) {
  return {
    profileDir: flags.profile || DEFAULT_PROFILE_DIR,
    chromePath: flags.chrome,
    headless: Boolean(flags.headless),
    timeoutMs: flags.timeout ? Number(flags.timeout) * 1000 : undefined,
  };
}

function printHelp() {
  console.log([
    "codex-chatgpt-web-minimal",
    "",
    "Commands:",
    "  extension",
    "  login [--transport extension|playwright] [--profile DIR] [--chrome PATH]",
    "  serve [--port 4318] [--transport extension|playwright]",
    "  install [--port 4318] [--replace-existing-route]",
    "  status [--port 4318]",
    "  restore",
    "",
    "Default transport is the unpacked extension in your normal Chrome profile (existing cookies).",
    "The server listens only on 127.0.0.1. No MCP tunnel or Electron launcher is used.",
  ].join("\n"));
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const port = numberFlag(flags.port, DEFAULT_PORT);
  const transport = flags.transport || "extension";
  if (transport !== "extension" && transport !== "playwright") throw new Error("Invalid transport: " + transport);
  if (command === "help" || command === "--help" || command === "-h") return printHelp();

  if (command === "extension") {
    console.log(EXTENSION_DIR);
    console.log("Open chrome://extensions, enable Developer mode, choose Load unpacked, and select this directory.");
    return;
  }

  if (command === "login") {
    if (transport === "extension") {
      console.log("Normal Chrome transport reuses the profile and ChatGPT cookies where the extension is loaded.");
      console.log("Extension directory: " + EXTENSION_DIR);
      console.log("Load it from chrome://extensions, then make sure https://chatgpt.com is already signed in.");
      return;
    }
    const login = await openLoginBrowser(browserOptions(flags));
    console.log("Dedicated ChatGPT browser opened with profile: " + login.profileDir);
    console.log("Sign in at chatgpt.com, then return here.");
    const input = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      await input.question("Press Enter after the ChatGPT composer is visible... ");
      const composerVisible = await login.page.locator('[data-testid="prompt-textarea"], #prompt-textarea, [contenteditable="true"][data-lexical-editor="true"]').first().isVisible().catch(() => false);
      if (!composerVisible) throw new Error("ChatGPT composer is not visible; login may be incomplete");
      console.log("Login profile is ready.");
    } finally {
      input.close();
      await login.context.close();
    }
    return;
  }

  if (command === "serve") {
    const browserClient = transport === "extension"
      ? new ExtensionBrowserClient({
          port: DEFAULT_EXTENSION_PORT,
          timeoutMs: flags.timeout ? Number(flags.timeout) * 1000 : undefined,
        })
      : new BrowserClient(browserOptions(flags));
    if (transport === "extension") await browserClient.start();
    const provider = createProviderServer({
      host: DEFAULT_HOST,
      port,
      browserClient,
    });
    const address = await provider.listen();
    console.log("Provider listening at " + address.baseUrl + "/v1");
    console.log("Models: chatgpt-web/browser (read-only) and chatgpt-web/agent (experimental tools)");
    if (transport === "extension") {
      console.log("Waiting for normal Chrome extension at ws://127.0.0.1:" + browserClient.port);
      console.log("Extension directory: " + EXTENSION_DIR);
    } else {
      console.log("Playwright fallback uses the dedicated profile: " + browserClient.profileDir);
    }
    let closing = false;
    const close = async signal => {
      if (closing) return;
      closing = true;
      console.log("Stopping provider after " + signal + "...");
      await provider.close();
      process.exit(0);
    };
    process.once("SIGINT", () => void close("SIGINT"));
    process.once("SIGTERM", () => void close("SIGTERM"));
    return;
  }

  if (command === "install") {
    const result = await installIntegration({
      endpoint: "http://127.0.0.1:" + port + "/v1",
      replaceExistingRoute: Boolean(flags["replace-existing-route"]),
    });
    console.log(result.changed ? "Codex routing installed." : "Codex routing was already installed.");
    console.log("Restart Codex, then choose chatgpt-web/browser or chatgpt-web/agent from the model picker.");
    return;
  }

  if (command === "restore") {
    const result = await restoreIntegration();
    console.log(result.changed ? "Previous Codex configuration restored." : "No active integration was found.");
    return;
  }

  if (command === "status") {
    const installed = await integrationStatus();
    let provider = { running: false };
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/healthz", { signal: AbortSignal.timeout(1500) });
      provider = { running: response.ok, ...(response.ok ? await response.json() : { status: response.status }) };
    } catch {
      // A stopped local provider is normal status output.
    }
    console.log(JSON.stringify({ integration: installed, provider }, null, 2));
    return;
  }

  printHelp();
  process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
