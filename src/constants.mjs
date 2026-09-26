import os from "node:os";
import path from "node:path";

export const APP_NAME = "codex-chatgpt-web-minimal";
export const WEB_MODEL = "chatgpt-web/browser";
export const WEB_AGENT_MODEL = "chatgpt-web/agent";
export const WEB_MODEL_PREFIX = "chatgpt-web/";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4318;
export const NATIVE_CODEX_BASE = "https://chatgpt.com/backend-api/codex";
export const TEMP_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
export const DEFAULT_STATE_DIR = path.join(os.homedir(), ".codex-chatgpt-web-minimal");
export const DEFAULT_PROFILE_DIR = path.join(DEFAULT_STATE_DIR, "chrome-profile");
export const DEFAULT_CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

export const COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  '#prompt-textarea',
  '[contenteditable="true"][data-lexical-editor="true"]',
  'form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]',
].join(", ");

export const SEND_BUTTON_SELECTOR = '[data-testid="send-button"], button[type="submit"]';
export const STOP_BUTTON_SELECTOR = '[data-testid="stop-button"], form[data-chatgpt-composer] button[aria-label="Stop"]';
export const ASSISTANT_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="assistant"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"]):not([data-turn-key] *)',
  '[data-turn-key]:has([data-conversation-role="assistant"], [data-chatgpt-agent-turn-start])',
].join(", ");
export const USER_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="user"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"][data-message-author-role="user"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"]):not([data-turn-key] *)',
  '[data-turn-key]:has([data-user-message-bubble])',
].join(", ");
