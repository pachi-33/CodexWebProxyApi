---
name: transparent-web-provider
description: Start, inspect, install, restore, or troubleshoot the local ChatGPT Web-backed transparent Codex model provider shipped with this plugin.
---

# Transparent ChatGPT Web provider

Use the plugin root's Node CLI. This plugin deliberately has no MCP server and no Secure MCP Tunnel.

1. Run `npm install` in the plugin root once.
2. Have the user load the unpacked `chrome-extension/` directory in their normal Chrome profile and confirm that profile is signed in to ChatGPT. Do not copy or export cookies.
3. Keep `npm start` running in a terminal; the default transport waits for the normal Chrome extension on loopback port 4319.
4. Run `node src/cli.mjs install` only when the user explicitly asks to route Codex through it.
5. Restart Codex and select `chatgpt-web/browser`.
6. Run `node src/cli.mjs restore` to restore the exact previous user configuration.

Explain that the provider is transparent at the Responses protocol boundary, but browser DOM changes can break it. `chatgpt-web/browser` is read-only. `chatgpt-web/agent` can emit nonce-bound Responses tool calls; Codex remains the only component that executes them under its existing sandbox and approval policy. Never execute raw ChatGPT page text as a shell command.

Use `login --transport playwright` and `serve --transport playwright` only as a fallback. Never point Playwright at the user's live daily Chrome profile.
