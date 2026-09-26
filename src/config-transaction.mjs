import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CODEX_HOME, DEFAULT_STATE_DIR } from "./constants.mjs";
import { ProviderError } from "./errors.mjs";

const MARKER = "# Managed by codex-chatgpt-web-minimal; restore with `codex-chatgpt-web restore`";

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => {});
}

async function atomicWrite(file, content, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
  await fs.writeFile(temporary, content, { mode });
  await fs.chmod(temporary, mode).catch(() => {});
  await fs.rename(temporary, file);
}

function topLevelValue(source, key) {
  const lines = source.split(/\r?\n/);
  for (const line of lines) {
    if (/^\s*\[/.test(line)) break;
    const match = new RegExp("^\\s*" + key + "\\s*=\\s*(?:\\\"([^\\\"]*)\\\"|'([^']*)')\\s*(?:#.*)?$").exec(line);
    if (match) return match[1] ?? match[2];
  }
  return undefined;
}

function installLine(source, endpoint, replaceExisting) {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source ? source.split(/\r?\n/) : [];
  const firstSection = lines.findIndex(line => /^\s*\[/.test(line));
  const limit = firstSection < 0 ? lines.length : firstSection;
  const matches = [];
  for (let index = 0; index < limit; index += 1) {
    if (/^\s*openai_base_url\s*=/.test(lines[index])) matches.push(index);
  }
  if (matches.length > 1) {
    throw new ProviderError("config.toml contains duplicate top-level openai_base_url entries", {
      status: 409,
      code: "ambiguous_codex_config",
    });
  }
  const newLine = 'openai_base_url = "' + endpoint + '"';
  if (matches.length === 1) {
    const current = topLevelValue(source, "openai_base_url");
    if (current === endpoint && lines[matches[0] - 1] === MARKER) return source;
    if (!replaceExisting) {
      throw new ProviderError("openai_base_url is already configured; pass --replace-existing-route to replace it safely", {
        status: 409,
        code: "existing_provider_route",
      });
    }
    lines.splice(matches[0], 1, newLine);
    if (lines[matches[0] - 1] !== MARKER) lines.splice(matches[0], 0, MARKER);
  } else {
    lines.splice(limit, 0, MARKER, newLine, "");
  }
  return lines.join(eol).replace(new RegExp(eol + "+$"), "") + eol;
}

async function resolveConfig(codexHome) {
  const requested = path.join(codexHome, "config.toml");
  if (!(await exists(requested))) return { requested, target: requested, existed: false, mode: 0o600, source: "" };
  const stat = await fs.lstat(requested);
  const target = stat.isSymbolicLink() ? await fs.realpath(requested) : requested;
  const targetStat = await fs.stat(target);
  return {
    requested,
    target,
    existed: true,
    mode: targetStat.mode & 0o777,
    source: await fs.readFile(target, "utf8"),
  };
}

export function integrationPaths(options = {}) {
  const stateDir = path.resolve(options.stateDir || DEFAULT_STATE_DIR);
  const codexHome = path.resolve(options.codexHome || DEFAULT_CODEX_HOME);
  return {
    stateDir,
    codexHome,
    journal: path.join(stateDir, "integration-journal.json"),
    modelsCache: path.join(codexHome, "models_cache.json"),
  };
}

export async function installIntegration(options = {}) {
  const paths = integrationPaths(options);
  const endpoint = options.endpoint;
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/v1$/.test(endpoint || "")) {
    throw new ProviderError("Install endpoint must be a loopback http:// URL ending in /v1", {
      status: 400,
      code: "invalid_install_endpoint",
    });
  }
  const healthUrl = endpoint.slice(0, -3) + "/healthz";
  let health;
  try {
    health = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
  } catch {
    throw new ProviderError("Provider health check failed at " + healthUrl, {
      status: 503,
      code: "provider_not_running",
    });
  }
  if (!health.ok) {
    throw new ProviderError("Provider health check returned HTTP " + health.status, {
      status: 503,
      code: "provider_not_running",
    });
  }
  await ensurePrivateDirectory(paths.stateDir);
  const config = await resolveConfig(paths.codexHome);
  const provider = topLevelValue(config.source, "model_provider");
  if (provider && provider !== "openai") {
    throw new ProviderError("model_provider is " + provider + "; transparent routing requires the built-in openai provider", {
      status: 409,
      code: "unsupported_model_provider",
    });
  }
  const installed = installLine(config.source, endpoint, Boolean(options.replaceExistingRoute));
  if (installed === config.source && await exists(paths.journal)) {
    return { changed: false, endpoint, configPath: config.target };
  }
  const journal = {
    version: 1,
    active: true,
    createdAt: new Date().toISOString(),
    requestedConfigPath: config.requested,
    configPath: config.target,
    configExisted: config.existed,
    configMode: config.mode,
    originalConfigBase64: Buffer.from(config.source).toString("base64"),
    installedEndpoint: endpoint,
    marker: MARKER,
  };
  await atomicWrite(paths.journal, JSON.stringify(journal, null, 2) + "\n", 0o600);
  try {
    await atomicWrite(config.target, installed, config.mode);
    await fs.rm(paths.modelsCache, { force: true });
  } catch (error) {
    if (config.existed) await atomicWrite(config.target, config.source, config.mode);
    else await fs.rm(config.target, { force: true });
    throw error;
  }
  return { changed: true, endpoint, configPath: config.target };
}

export async function restoreIntegration(options = {}) {
  const paths = integrationPaths(options);
  if (!(await exists(paths.journal))) return { changed: false };
  const journal = JSON.parse(await fs.readFile(paths.journal, "utf8"));
  const current = await fs.readFile(journal.configPath, "utf8").catch(() => "");
  const expectedLine = 'openai_base_url = "' + journal.installedEndpoint + '"';
  if (!current.includes(journal.marker) || !current.includes(expectedLine)) {
    throw new ProviderError("Codex config changed after install; refusing to overwrite it during restore", {
      status: 409,
      code: "codex_config_changed",
    });
  }
  const original = Buffer.from(journal.originalConfigBase64, "base64");
  if (journal.configExisted) await atomicWrite(journal.configPath, original, journal.configMode || 0o600);
  else await fs.rm(journal.configPath, { force: true });
  await fs.rm(paths.modelsCache, { force: true });
  await fs.rm(paths.journal, { force: true });
  return { changed: true, configPath: journal.configPath };
}

export async function integrationStatus(options = {}) {
  const paths = integrationPaths(options);
  if (!(await exists(paths.journal))) return { installed: false };
  const journal = JSON.parse(await fs.readFile(paths.journal, "utf8"));
  return {
    installed: true,
    endpoint: journal.installedEndpoint,
    configPath: journal.configPath,
  };
}
