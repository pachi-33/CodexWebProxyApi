import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import {
  ASSISTANT_TURN_SELECTOR,
  COMPOSER_SELECTOR,
  DEFAULT_PROFILE_DIR,
  SEND_BUTTON_SELECTOR,
  STOP_BUTTON_SELECTOR,
  TEMP_CHAT_URL,
  USER_TURN_SELECTOR,
} from "./constants.mjs";
import { ProviderError } from "./errors.mjs";
import { htmlToMarkdown } from "./markdown.mjs";

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export async function resolveChromePath(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.CHROME_PATH,
    process.platform === "darwin" ? MAC_CHROME : undefined,
    process.platform === "linux" ? "/usr/bin/google-chrome" : undefined,
    process.platform === "linux" ? "/usr/bin/chromium" : undefined,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next known system browser.
    }
  }
  throw new ProviderError("Google Chrome was not found; pass --chrome /absolute/path", {
    status: 500,
    code: "chrome_not_found",
  });
}

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => {});
}

async function visibleLocators(locator) {
  const result = [];
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) result.push(item);
  }
  return result;
}

async function uniqueVisible(locator, label) {
  const visible = await visibleLocators(locator);
  if (visible.length !== 1) {
    throw new ProviderError(label + " expected exactly one visible element, found " + visible.length, {
      status: 502,
      code: "chatgpt_dom_changed",
    });
  }
  return visible[0];
}

async function snapshots(page, selector, role) {
  const rows = await page.locator(selector).evaluateAll((nodes, expectedRole) => nodes.map((node, index) => {
    const element = node;
    const keyOwner = element.hasAttribute("data-turn-key") ? element : element.closest("[data-turn-key]");
    const key = keyOwner && keyOwner.getAttribute("data-turn-key");
    const idOwner = element.hasAttribute("data-turn-id")
      ? element
      : element.querySelector("[data-turn-id]") || element.closest("[data-turn-id]");
    const turnId = idOwner && idOwner.getAttribute("data-turn-id");
    const testId = element.getAttribute("data-testid");
    const identity = key
      ? "group:" + expectedRole + ":" + key
      : turnId
        ? "turn:" + expectedRole + ":" + turnId
        : testId
          ? "test:" + expectedRole + ":" + testId
          : "unkeyed:" + expectedRole + ":" + index;
    return {
      identity,
      html: element.innerHTML,
      text: (element.innerText || "").trim(),
    };
  }), role);
  const deduped = new Map();
  for (const row of rows) deduped.set(row.identity, row);
  return [...deduped.values()];
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(signal.reason || new Error("Aborted"));
    const timer = setTimeout(done, ms);
    function done() {
      if (signal) signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal.reason || new Error("Aborted"));
    }
    if (signal) signal.addEventListener("abort", aborted, { once: true });
  });
}

export class BrowserClient {
  constructor(options = {}) {
    this.profileDir = path.resolve(options.profileDir || DEFAULT_PROFILE_DIR);
    this.chromePath = options.chromePath;
    this.headless = Boolean(options.headless);
    this.timeoutMs = options.timeoutMs || 10 * 60 * 1000;
    this.context = null;
  }

  async start() {
    if (this.context) return this.context;
    await ensurePrivateDirectory(this.profileDir);
    const executablePath = await resolveChromePath(this.chromePath);
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      executablePath,
      headless: this.headless,
      viewport: { width: 1280, height: 900 },
      locale: "zh-CN",
    });
    return this.context;
  }

  async close() {
    const current = this.context;
    this.context = null;
    if (current) await current.close().catch(() => {});
  }

  async run(prompt, options = {}) {
    const context = await this.start();
    const page = await context.newPage();
    const effectivePrompt = options.continuation && options.recoveryPrompt
      ? options.recoveryPrompt
      : prompt;
    const signal = options.signal;
    const abort = () => {
      void page.locator(STOP_BUTTON_SELECTOR).first().click({ timeout: 1000 }).catch(() => {});
      void page.close().catch(() => {});
    };
    if (signal) signal.addEventListener("abort", abort, { once: true });
    try {
      await page.goto(TEMP_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      if (new URL(page.url()).hostname !== "chatgpt.com") {
        throw new ProviderError("ChatGPT redirected outside chatgpt.com", { status: 401, code: "not_authenticated" });
      }
      const composer = await uniqueVisible(page.locator(COMPOSER_SELECTOR), "ChatGPT composer");
      const assistantBefore = new Set((await snapshots(page, ASSISTANT_TURN_SELECTOR, "assistant")).map(row => row.identity));
      const userBefore = new Set((await snapshots(page, USER_TURN_SELECTOR, "user")).map(row => row.identity));

      await composer.evaluate((element, text) => {
        element.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
        if (!document.execCommand("insertText", false, text)) {
          element.textContent = text;
          element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
        }
      }, effectivePrompt);
      const inserted = (await composer.innerText()).trim();
      if (inserted !== effectivePrompt.trim()) {
        throw new ProviderError("ChatGPT composer did not retain the complete prompt", {
          status: 502,
          code: "composer_write_failed",
        });
      }

      const form = composer.locator("xpath=ancestor::form[1]");
      const send = await uniqueVisible(form.locator(SEND_BUTTON_SELECTOR), "ChatGPT send button");
      await send.click();
      await this.waitForSubmission(page, assistantBefore, userBefore, signal);
      const result = await this.waitForAnswer(page, assistantBefore, signal);
      if (!result.markdown) {
        throw new ProviderError("ChatGPT returned an empty assistant response", {
          status: 502,
          code: "empty_browser_response",
        });
      }
      return { ...result, url: page.url() };
    } finally {
      if (signal) signal.removeEventListener("abort", abort);
      await page.close().catch(() => {});
    }
  }

  async waitForSubmission(page, assistantBefore, userBefore, signal) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (signal && signal.aborted) throw signal.reason || new Error("Aborted");
      const assistants = await snapshots(page, ASSISTANT_TURN_SELECTOR, "assistant");
      const users = await snapshots(page, USER_TURN_SELECTOR, "user");
      const accepted = assistants.some(row => !assistantBefore.has(row.identity))
        || users.some(row => !userBefore.has(row.identity))
        || (await page.locator(STOP_BUTTON_SELECTOR).first().isVisible().catch(() => false));
      if (accepted) return;
      await sleep(250, signal);
    }
    throw new ProviderError("ChatGPT did not confirm prompt submission; the prompt was not retried", {
      status: 502,
      code: "chatgpt_submission_ambiguous",
    });
  }

  async waitForAnswer(page, assistantBefore, signal) {
    const deadline = Date.now() + this.timeoutMs;
    let identity = null;
    let lastMarkdown = "";
    let stable = 0;
    while (Date.now() < deadline) {
      if (signal && signal.aborted) throw signal.reason || new Error("Aborted");
      const all = await snapshots(page, ASSISTANT_TURN_SELECTOR, "assistant");
      const fresh = all.filter(row => !assistantBefore.has(row.identity));
      if (fresh.length > 1) {
        throw new ProviderError("More than one new ChatGPT assistant turn appeared", {
          status: 502,
          code: "chatgpt_turn_binding_ambiguous",
        });
      }
      if (fresh.length === 1) {
        if (identity && fresh[0].identity !== identity) {
          throw new ProviderError("The bound ChatGPT assistant turn changed identity", {
            status: 502,
            code: "chatgpt_turn_binding_changed",
          });
        }
        identity = fresh[0].identity;
        const markdown = htmlToMarkdown(fresh[0].html);
        if (markdown && markdown === lastMarkdown) stable += 1;
        else stable = 0;
        lastMarkdown = markdown;
        const generating = await page.locator(STOP_BUTTON_SELECTOR).first().isVisible().catch(() => false);
        if (!generating && markdown && stable >= 2) {
          return { markdown, text: fresh[0].text, identity };
        }
      }
      await sleep(700, signal);
    }
    throw new ProviderError("Timed out waiting for the bound ChatGPT assistant turn", {
      status: 504,
      code: "browser_response_timeout",
    });
  }
}

export async function openLoginBrowser(options = {}) {
  const profileDir = path.resolve(options.profileDir || DEFAULT_PROFILE_DIR);
  await ensurePrivateDirectory(profileDir);
  const executablePath = await resolveChromePath(options.chromePath);
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: "zh-CN",
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto(TEMP_CHAT_URL, { waitUntil: "domcontentloaded" });
  return { context, page, profileDir };
}
