import { promisify } from "node:util";
import * as zlib from "node:zlib";
import { ProviderError } from "./errors.mjs";

const MAX_DECODED_BODY_BYTES = 24 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;
const zstdDecompress = typeof zlib.zstdDecompress === "function"
  ? promisify(zlib.zstdDecompress)
  : null;

function bodyError(message, options = {}) {
  return new ProviderError(message, {
    status: options.status || 400,
    type: "invalid_request_error",
    code: options.code || "invalid_json",
  });
}

export async function decodeRequestBody(encoded, contentEncoding) {
  const encoding = String(contentEncoding || "identity").trim().toLowerCase();
  if (!encoding || encoding === "identity") return encoded;
  if (encoding !== "zstd") {
    throw bodyError("Unsupported Content-Encoding: " + encoding, {
      status: 415,
      code: "unsupported_content_encoding",
    });
  }
  if (!zstdDecompress) {
    throw bodyError("This Node.js runtime does not support zstd; use Node.js 22.15 or newer", {
      status: 500,
      code: "zstd_unavailable",
    });
  }

  let decoded;
  try {
    decoded = await zstdDecompress(encoded, { maxOutputLength: MAX_DECODED_BODY_BYTES });
  } catch {
    throw bodyError("Request body has invalid or incomplete zstd data", {
      code: "invalid_content_encoding",
    });
  }
  if (decoded.length > MAX_DECODED_BODY_BYTES) {
    throw bodyError("Decoded request body is too large", {
      status: 413,
      code: "request_too_large",
    });
  }
  if (encoded.length > 0 && decoded.length > encoded.length * MAX_COMPRESSION_RATIO) {
    throw bodyError("Decoded request body exceeds the compression ratio limit", {
      status: 413,
      code: "request_too_large",
    });
  }
  return decoded;
}

export async function parseJsonRequestBody(encoded, contentEncoding) {
  const decoded = await decodeRequestBody(encoded, contentEncoding);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    throw bodyError("Request body must be valid UTF-8 JSON");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw bodyError("Request body must be valid JSON");
  }
}
