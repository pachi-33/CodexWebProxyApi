import http from "node:http";
import { BrowserClient } from "./browser-client.mjs";
import { DEFAULT_HOST, DEFAULT_PORT, WEB_MODEL_PREFIX } from "./constants.mjs";
import { ContinuationStore } from "./continuations.mjs";
import { errorBody, ProviderError } from "./errors.mjs";
import { parseJsonRequestBody } from "./http-body.mjs";
import { augmentModelCatalog, fetchNative, pipeFetchResponse, webOnlyModelCatalog } from "./native-proxy.mjs";
import { compileBrowserPrompt, parseBrowserClientResult, parseResponsesRequest } from "./prompt-compiler.mjs";
import {
  completedResponseFromOutput,
  createResponseEnvelope,
  ResponsesSSE,
  resultToOutput,
} from "./responses-wire.mjs";

const MAX_BODY_BYTES = 24 * 1024 * 1024;

async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      throw new ProviderError("Request body is too large", {
        status: 413,
        type: "invalid_request_error",
        code: "request_too_large",
      });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

export function createProviderServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new ProviderError("The provider may only listen on loopback", {
      status: 400,
      code: "loopback_required",
    });
  }
  const port = Number(options.port ?? DEFAULT_PORT);
  const browser = options.browserClient || new BrowserClient(options.browser || {});
  const continuations = options.continuations || new ContinuationStore();
  const state = { busy: false, activeAbort: null };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        return json(res, 200, {
          status: "ok",
          busy: state.busy,
          models: ["chatgpt-web/browser", "chatgpt-web/agent"],
          ...(typeof browser.status === "function" ? browser.status() : { transport: "playwright" }),
        });
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        const authorization = String(req.headers.authorization || "");
        if (!authorization.startsWith("Bearer ")) {
          return json(res, 200, webOnlyModelCatalog());
        }
        const controller = new AbortController();
        req.once("aborted", () => controller.abort(new Error("Client disconnected")));
        const upstream = await fetchNative(req, undefined, { fetchImpl: options.fetchImpl, signal: controller.signal });
        return await pipeFetchResponse(upstream, res, augmentModelCatalog);
      }
      if (req.method === "GET" && url.pathname === "/v1/responses") {
        res.writeHead(426, { "content-type": "text/plain; charset=utf-8" });
        return res.end("Responses WebSocket transport is not implemented\n");
      }

      const passthroughPaths = new Set([
        "/v1/responses",
        "/v1/responses/compact",
        "/v1/alpha/search",
        "/v1/images/generations",
        "/v1/images/edits",
      ]);
      if (req.method === "POST" && passthroughPaths.has(url.pathname)) {
        const body = await readBody(req);
        let parsed = null;
        const contentType = String(req.headers["content-type"] || "");
        if (contentType.includes("application/json") || url.pathname.startsWith("/v1/responses")) {
          parsed = await parseJsonRequestBody(body, req.headers["content-encoding"]);
        }
        const webRequest = parsed && typeof parsed.model === "string" && parsed.model.startsWith(WEB_MODEL_PREFIX);
        if (!webRequest) {
          const controller = new AbortController();
          req.once("aborted", () => controller.abort(new Error("Client disconnected")));
          const upstream = await fetchNative(req, body, { fetchImpl: options.fetchImpl, signal: controller.signal });
          return await pipeFetchResponse(upstream, res);
        }
        if (url.pathname !== "/v1/responses") {
          throw new ProviderError("This browser model does not implement " + url.pathname, {
            status: 409,
            type: "invalid_request_error",
            code: "unsupported_browser_endpoint",
          });
        }
        if (state.busy) {
          throw new ProviderError("The browser provider is handling another request", {
            status: 429,
            type: "rate_limit_error",
            code: "browser_busy",
          });
        }
        const request = parseResponsesRequest(parsed, continuations);
        const compiled = compileBrowserPrompt(request);
        const envelope = createResponseEnvelope(request.model, request.previousResponseId);
        const browserSessionId = request.browserSessionId || envelope.id;
        const controller = new AbortController();
        state.busy = true;
        state.activeAbort = controller;
        let completed = false;
        const disconnect = () => {
          if (!completed) controller.abort(new Error("Codex client disconnected"));
        };
        req.once("aborted", disconnect);
        res.once("close", disconnect);

        if (!request.stream) {
          try {
            const result = await browser.run(compiled.prompt, {
              signal: controller.signal,
              conversationId: browserSessionId,
              continuation: Boolean(request.browserSessionId),
              recoveryPrompt: compiled.recoveryPrompt,
              agentNonce: compiled.mode === "agent" ? compiled.nonce : null,
            });
            const output = resultToOutput(envelope, parseBrowserClientResult(result, compiled));
            const response = completedResponseFromOutput(envelope, output);
            continuations.remember(envelope.id, request.expandedInput, response.output, { browserSessionId });
            completed = true;
            return json(res, 200, response);
          } finally {
            state.busy = false;
            state.activeAbort = null;
          }
        }

        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-store",
          connection: "keep-alive",
        });
        const wire = new ResponsesSSE(res, envelope);
        wire.created();
        const heartbeat = setInterval(() => {
          if (!res.destroyed && !res.writableEnded) wire.heartbeat();
        }, 2000);
        try {
          const result = await browser.run(compiled.prompt, {
            signal: controller.signal,
            conversationId: browserSessionId,
            continuation: Boolean(request.browserSessionId),
            recoveryPrompt: compiled.recoveryPrompt,
            agentNonce: compiled.mode === "agent" ? compiled.nonce : null,
          });
          const output = resultToOutput(envelope, parseBrowserClientResult(result, compiled));
          const response = completedResponseFromOutput(envelope, output);
          continuations.remember(envelope.id, request.expandedInput, response.output, { browserSessionId });
          clearInterval(heartbeat);
          completed = true;
          wire.completeOutput(output);
        } catch (error) {
          clearInterval(heartbeat);
          if (!res.destroyed && !res.writableEnded) wire.fail(error);
        } finally {
          state.busy = false;
          state.activeAbort = null;
        }
        return;
      }
      throw new ProviderError("Not found", { status: 404, code: "not_found" });
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      const status = error instanceof ProviderError ? error.status : 500;
      json(res, status, errorBody(error));
    }
  });

  return {
    server,
    browser,
    state,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      const address = server.address();
      const actualPort = address && typeof address === "object" ? address.port : port;
      return { host, port: actualPort, baseUrl: "http://" + host + ":" + actualPort };
    },
    async close() {
      if (state.activeAbort) state.activeAbort.abort(new Error("Provider shutting down"));
      await new Promise(resolve => server.close(resolve));
      await browser.close();
    },
  };
}
