# Contributing

Contributions are welcome through GitHub issues and pull requests.

## Development setup

```bash
npm ci
npm test
```

Tests use fake browser transports and temporary loopback servers; they do not require a ChatGPT login. For a live smoke test, load `chrome-extension/` as an unpacked extension, run `npm start`, and follow the verification steps in the README.

## Pull requests

- Keep the provider and WebSocket bridge loopback-only.
- Never add cookie export, browser credential extraction, or raw execution of ChatGPT page text.
- Add regression tests for protocol, DOM, continuation, and configuration changes.
- Update `CHANGELOG.md` for user-visible changes.
- Run `npm test` before submitting.

By contributing, you agree that your contribution is licensed under the MIT License.
