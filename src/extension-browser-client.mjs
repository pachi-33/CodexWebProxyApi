import crypto from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { ProviderError } from "./errors.mjs";
import { htmlToMarkdown } from "./markdown.mjs";

export const DEFAULT_EXTENSION_PORT = 4319;

export class ExtensionBrowserClient {
  constructor(options = {}) {
    this.host = "127.0.0.1";
    this.port = Number(options.port ?? DEFAULT_EXTENSION_PORT);
    this.timeoutMs = options.timeoutMs || 10 * 60 * 1000;
    this.server = null;
    this.socket = null;
    this.extensionVersion = null;
    this.pending = new Map();
    this.connectionWaiters = new Set();
  }

  async start() {
    if (this.server) return;
    const server = new WebSocketServer({
      host: this.host,
      port: this.port,
      verifyClient: info => typeof info.origin === "string" && info.origin.startsWith("chrome-extension://"),
    });
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    this.server = server;
    const address = server.address();
    if (address && typeof address === "object") this.port = address.port;
    server.on("connection", socket => this.accept(socket));
  }

  accept(socket) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close(1012, "A newer extension connection replaced this one");
    }
    this.socket = socket;
    this.extensionVersion = null;
    for (const resolve of this.connectionWaiters) resolve();
    this.connectionWaiters.clear();
    socket.on("message", data => this.onMessage(data));
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = null;
        this.extensionVersion = null;
      }
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(new ProviderError("The normal Chrome extension disconnected", {
          status: 503,
          code: "chrome_extension_disconnected",
        }));
        this.pending.delete(id);
      }
    });
  }

  onMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (message.type === "hello") {
      this.extensionVersion = typeof message.extensionVersion === "string"
        ? message.extensionVersion
        : null;
      return;
    }
    if (message.type !== "result" || typeof message.id !== "string") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (!message.ok) {
      pending.reject(new ProviderError(message.error || "The Chrome extension browser turn failed", {
        status: 502,
        code: message.code || "chrome_extension_error",
      }));
      return;
    }
    const text = String(message.text || "").trim();
    const markdown = typeof message.html === "string"
      ? htmlToMarkdown(message.html)
      : text;
    if (!markdown && !text) {
      pending.reject(new ProviderError("The normal Chrome tab returned an empty response", {
        status: 502,
        code: "empty_browser_response",
      }));
      return;
    }
    pending.resolve({
      markdown,
      text,
      identity: message.identity,
      url: message.url,
      transport: "extension",
    });
  }

  async waitForConnection(timeoutMs = 3000) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.connectionWaiters.delete(connected);
        reject(new ProviderError(
          "Normal Chrome extension is not connected; load chrome-extension/ and keep Chrome running",
          { status: 503, code: "chrome_extension_not_connected" },
        ));
      }, timeoutMs);
      const connected = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.connectionWaiters.add(connected);
    });
  }

  async run(prompt, options = {}) {
    await this.start();
    await this.waitForConnection();
    const id = "browser_" + crypto.randomUUID().replaceAll("-", "");
    const timeoutMs = options.timeoutMs || this.timeoutMs;
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        this.trySend({ type: "cancel", id });
        reject(new ProviderError("Timed out waiting for the normal Chrome extension", {
          status: 504,
          code: "browser_response_timeout",
        }));
      }, timeoutMs + 30_000);
      const abort = () => {
        this.pending.delete(id);
        clearTimeout(timeout);
        this.trySend({ type: "cancel", id });
        reject(options.signal.reason || new Error("Browser turn aborted"));
      };
      if (options.signal) {
        if (options.signal.aborted) return abort();
        options.signal.addEventListener("abort", abort, { once: true });
      }
      this.pending.set(id, {
        timeout,
        resolve: value => {
          if (options.signal) options.signal.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: error => {
          if (options.signal) options.signal.removeEventListener("abort", abort);
          reject(error);
        },
      });
      try {
        this.send({
          type: "run",
          id,
          prompt,
          recoveryPrompt: options.recoveryPrompt,
          conversationId: options.conversationId,
          continuation: Boolean(options.continuation),
          agentNonce: options.agentNonce,
          timeoutMs,
        });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timeout);
        if (options.signal) options.signal.removeEventListener("abort", abort);
        reject(error);
      }
    });
  }

  send(value) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new ProviderError("Normal Chrome extension is not connected", {
        status: 503,
        code: "chrome_extension_not_connected",
      });
    }
    this.socket.send(JSON.stringify(value));
  }

  trySend(value) {
    try {
      this.send(value);
    } catch {
      // Cancellation is best-effort after a browser disconnect.
    }
  }

  status() {
    return {
      transport: "normal-chrome-extension",
      extension_port: this.port,
      extension_connected: Boolean(this.socket && this.socket.readyState === WebSocket.OPEN),
      extension_version: this.extensionVersion,
    };
  }

  async close() {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Provider shutting down"));
      this.pending.delete(id);
    }
    if (this.socket) this.socket.close(1001, "Provider shutting down");
    this.socket = null;
    this.extensionVersion = null;
    const server = this.server;
    this.server = null;
    if (server) await new Promise(resolve => server.close(resolve));
  }
}
