import { Readable } from "node:stream";
import { NATIVE_CODEX_BASE, WEB_AGENT_MODEL, WEB_MODEL } from "./constants.mjs";
import { ProviderError } from "./errors.mjs";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

function endToEndHeaders(source) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (value == null || HOP_BY_HOP.has(name.toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

export function nativeTargetUrl(incomingUrl) {
  const url = new URL(incomingUrl, "http://127.0.0.1");
  if (!url.pathname.startsWith("/v1/")) {
    throw new ProviderError("Unsupported proxy path", { status: 404, code: "not_found" });
  }
  return NATIVE_CODEX_BASE + "/" + url.pathname.slice(4) + url.search;
}

export async function fetchNative(req, body, options = {}) {
  const authorization = req.headers.authorization || "";
  if (!authorization.startsWith("Bearer ")) {
    throw new ProviderError("Native Codex passthrough requires Bearer authorization", {
      status: 401,
      type: "authentication_error",
      code: "missing_authorization",
    });
  }
  const headers = endToEndHeaders(req.headers);
  if (req.method === "GET") headers.delete("if-none-match");
  return (options.fetchImpl || fetch)(nativeTargetUrl(req.url), {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    signal: options.signal,
    redirect: "error",
  });
}

export function buildWebModel(template = {}, options = {}) {
  const model = structuredClone(template);
  const agent = Boolean(options.agent);
  Object.assign(model, {
    slug: agent ? WEB_AGENT_MODEL : WEB_MODEL,
    id: agent ? WEB_AGENT_MODEL : WEB_MODEL,
    display_name: agent ? "ChatGPT Web (Agent, experimental)" : "ChatGPT Web (Browser)",
    description: agent
      ? "Browser-backed model with local Responses tool-call translation; no MCP tunnel"
      : "Local browser-backed text model; no MCP tunnel and no local tool execution",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    context_window: 90000,
    max_context_window: 90000,
    effective_context_window_percent: 88,
    auto_compact_token_limit: 80000,
    input_modalities: ["text"],
    supported_reasoning_levels: [{ effort: "medium", description: "Browser default" }],
    default_reasoning_level: "medium",
    multi_agent_version: "disabled",
    // null keeps the ordinary Responses tool registry instead of collapsing it into code mode.
    tool_mode: null,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
  });
  delete model.comp_hash;
  delete model.availability_nux;
  return model;
}

export function augmentModelCatalog(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.models)) {
    throw new ProviderError("Native Codex model catalog has no models array", {
      status: 502,
      code: "invalid_native_catalog",
    });
  }
  const nativeModels = structuredClone(value.models.filter(model => {
    const slug = model && typeof model === "object" ? model.slug : null;
    return typeof slug !== "string" || !slug.startsWith("chatgpt-web/");
  }));
  const template = nativeModels.find(model => model && model.supported_in_api !== false) || nativeModels[0] || {};
  return {
    ...structuredClone(value),
    models: [...nativeModels, buildWebModel(template), buildWebModel(template, { agent: true })],
  };
}

export function webOnlyModelCatalog() {
  return augmentModelCatalog({ models: [] });
}

export async function pipeFetchResponse(upstream, res, transformJson) {
  let body = upstream.body;
  const headers = new Headers(upstream.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("etag");
  if (transformJson && upstream.ok) {
    const value = await upstream.json();
    const encoded = Buffer.from(JSON.stringify(transformJson(value)));
    body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    });
    headers.set("content-type", "application/json; charset=utf-8");
  }
  res.writeHead(upstream.status, Object.fromEntries(headers.entries()));
  if (!body) return res.end();
  await new Promise((resolve, reject) => {
    Readable.fromWeb(body).on("error", reject).on("end", resolve).pipe(res);
  });
}
