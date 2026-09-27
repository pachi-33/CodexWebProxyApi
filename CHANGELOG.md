# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Added

- Keyless web-only operation: unauthenticated `/v1/models` requests receive the two `chatgpt-web/*` models, and their Responses requests require no API key.
- Documented a no-auth Codex custom-provider configuration for local web models.

### Security

- Native Codex passthrough continues to require bearer authentication; keyless access remains limited to the loopback-only web-model routes.

## [0.1.6] - 2026-09-27

First public release.

### Added

- Loopback Responses-compatible provider for Codex.
- Normal Chrome transport through a Manifest V3 extension, reusing the user's existing ChatGPT login without exporting cookies.
- `chatgpt-web/browser` for browser-backed text responses.
- Experimental `chatgpt-web/agent` with nonce-bound function and custom tool-call translation.
- Same-conversation tool continuations with delta-only tool results.
- Native Codex model passthrough and augmented model catalog.
- Transactional Codex configuration install and exact restore commands.
- Playwright fallback using an isolated browser profile.
- Health/status endpoints and automated protocol, streaming, continuation, and extension tests.

### Reliability and security

- Provider and WebSocket bridge listen on loopback only.
- WebSocket connections accept Chrome extension origins only.
- Host instructions, skills, permissions, plugin metadata, and environment context are removed from browser-visible prompts.
- Agent responses are accepted only after the matching nonce-bound JSON envelope is structurally complete.
- Concurrent retries cannot navigate the provider tab while a response is still running.
- Tool calls are returned to Codex for execution under its sandbox and approval policy; the proxy never executes page text itself.

[0.1.6]: https://github.com/pachi-33/CodexWebProxyApi/releases/tag/v0.1.6
