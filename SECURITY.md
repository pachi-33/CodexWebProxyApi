# Security policy

## Supported versions

Only the latest release is supported with security fixes.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability involving authentication data, command execution, origin validation, or prompt/tool-call validation. Use GitHub's private vulnerability reporting feature on this repository instead.

Include the affected version, reproduction steps, impact, and any suggested mitigation. Avoid attaching real cookies, bearer tokens, or private prompts.

## Security boundaries

- The HTTP provider and extension bridge bind only to loopback addresses.
- ChatGPT cookies stay inside Chrome and are not read by Node.js.
- Native Codex authorization headers are forwarded in memory and are not logged or persisted.
- Browser text is never executed directly. Agent tool calls must pass the nonce-bound envelope parser and declared-tool lookup before they are returned to Codex.
- Codex remains responsible for sandboxing, approvals, and actual local tool execution.

This project automates an authenticated web UI. Treat the browser account and the machine running Codex as trusted components, and review changes before running unreleased code.
