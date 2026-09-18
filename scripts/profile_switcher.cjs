"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const OPENAI_PROVIDER = "openai";

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function activeProvider(configText) {
  const header = topLevelHeader(configText);
  const match = header.match(/^\s*model_provider\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m);
  return match?.[1] || OPENAI_PROVIDER;
}

function topLevelHeader(configText) {
  const firstSection = configText.search(/^\s*\[/m);
  return firstSection === -1 ? configText : configText.slice(0, firstSection);
}

function rewriteModelProvider(configText, provider) {
  const firstSection = configText.search(/^\s*\[/m);
  const header = firstSection === -1 ? configText : configText.slice(0, firstSection);
  const body = firstSection === -1 ? "" : configText.slice(firstSection);
  const replacement = `model_provider = "${provider}"`;
  const activeLine = /^\s*model_provider\s*=.*$/m;
  const commentedLine = /^\s*#\s*model_provider\s*=.*$/m;

  if (activeLine.test(header)) {
    return header.replace(activeLine, replacement) + body;
  }
  if (commentedLine.test(header)) {
    return header.replace(commentedLine, replacement) + body;
  }

  const modelLine = /^(\s*model\s*=.*(?:\r?\n|$))/m;
  if (modelLine.test(header)) {
    return header.replace(modelLine, `$1${replacement}\n`) + body;
  }
  return `${replacement}\n${configText}`;
}

function configuredProviders(configText) {
  const providers = [{ provider: OPENAI_PROVIDER, label: "OpenAI" }];
  const sectionPattern = /^\s*\[model_providers\.([A-Za-z0-9_-]+)\]\s*$/gm;
  const matches = [...configText.matchAll(sectionPattern)];
  for (const [index, match] of matches.entries()) {
    const provider = match[1];
    if (provider === OPENAI_PROVIDER) {
      continue;
    }
    const sectionStart = match.index + match[0].length;
    const sectionEnd = matches[index + 1]?.index ?? configText.length;
    const section = configText.slice(sectionStart, sectionEnd);
    const name = section.match(/^\s*name\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m)?.[1];
    providers.push({ provider, label: name?.trim() || provider });
  }
  return providers;
}

const BUDGET_POLL_INTERVAL_MS = 10000;
const BUDGET_FETCH_TIMEOUT_MS = 5000;
const USAGE_POLL_INTERVAL_MS = 60000;
const USAGE_FETCH_TIMEOUT_MS = 15000;
// The renderer reports the usage the app itself displays; while those reports
// keep arriving, the app-server poll is only a fallback.
const LIVE_USAGE_TRUST_MS = 5 * 60 * 1000;

function providerSection(configText, provider) {
  const sectionPattern = /^\s*\[model_providers\.([A-Za-z0-9_-]+)\]\s*$/gm;
  for (const match of configText.matchAll(sectionPattern)) {
    if (match[1] !== provider) {
      continue;
    }
    const rest = configText.slice(match.index + match[0].length);
    const nextHeader = rest.search(/^\s*\[/m);
    return nextHeader === -1 ? rest : rest.slice(0, nextHeader);
  }
  return null;
}

function providerBudgetSource(configText, provider) {
  if (provider === OPENAI_PROVIDER) {
    return null;
  }
  const section = providerSection(configText, provider);
  if (section == null) {
    return null;
  }
  const baseUrl = section.match(/^\s*base_url\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m)?.[1];
  const envKey = section.match(/^\s*env_key\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m)?.[1];
  const apiKey = envKey ? process.env[envKey] : null;
  if (!baseUrl || !apiKey) {
    return null;
  }
  // LiteLLM serves key metadata at the proxy root, not under /v1.
  const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  return { url: `${root}/key/info`, apiKey };
}

async function fetchBudget(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BUDGET_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(source.url, {
      headers: { Authorization: `Bearer ${source.apiKey}` },
      signal: controller.signal,
    });
    // A proxy without the key-info endpoint, or one that reports no budget
    // for the key, simply has no usage to show; that is not a failure.
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      return { unsupported: true };
    }
    if (!response.ok) {
      return { error: `proxy answered ${response.status}` };
    }
    const body = await response.json();
    const info = body?.info ?? body;
    const spend = Number(info?.spend);
    const maxBudget = Number(info?.max_budget);
    if (!Number.isFinite(spend) || !Number.isFinite(maxBudget) || maxBudget <= 0) {
      return { unsupported: true };
    }
    return {
      budget: {
        spend,
        maxBudget,
        resetAt: typeof info?.budget_reset_at === "string" ? info.budget_reset_at : null,
      },
    };
  } catch (error) {
    return { error: error?.name === "AbortError" ? "proxy timed out" : "proxy unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

function codexBinary() {
  const candidates = [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function readAccountRateLimits() {
  const binary = codexBinary();
  if (binary == null) {
    return Promise.resolve({ error: "Codex binary not found" });
  }
  return new Promise((resolve) => {
    // The provider override keeps this app server pointed at OpenAI even while
    // config.toml selects a proxy, so it never refreshes models over that proxy.
    const child = spawn(binary, ["app-server", "-c", 'model_provider="openai"'], {
      stdio: ["pipe", "pipe", "ignore"],
    });

    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // The app server already exited.
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ error: "app server timed out" }), USAGE_FETCH_TIMEOUT_MS);
    const send = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        finish({ error: "app server not writable" });
      }
    };

    child.on("error", () => finish({ error: "app server failed to start" }));
    child.on("exit", () => finish({ error: "app server exited" }));
    child.stdin.on("error", () => finish({ error: "app server not writable" }));
    child.stdout.setEncoding("utf8");

    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          continue;
        }
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "initialized", params: null });
          send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read" });
        } else if (message.id === 2) {
          finish(
            message.error != null
              ? { error: String(message.error.message ?? "rate limits unavailable") }
              : { response: message.result ?? null },
          );
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "codex-mod", version: "1" } },
    });
  });
}

// The ChatGPT backend answers with this code once the account has been
// signed out, which invalidates every copy of its tokens.
function isRevokedTokenError(error) {
  return /"code":\s*"token_revoked"/.test(String(error ?? ""));
}

function windowLabel(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return "usage";
  }
  if (minutes % 1440 === 0) {
    return `${minutes / 1440}d`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }
  return `${minutes}m`;
}

function availableResets(response) {
  const count = Number(response?.rateLimitResetCredits?.availableCount);
  return Number.isFinite(count) && count > 0 ? count : null;
}

// The app reads its own usage display from the ChatGPT backend's /wham/usage
// response; this maps that payload onto the app-server's rate-limit shape so
// both sources feed the same rows.
function rateLimitsFromUsage(usage) {
  const windows = usage?.rate_limit;
  if (windows == null || typeof windows !== "object") {
    return null;
  }
  const convert = (window) => {
    if (window == null || typeof window !== "object") {
      return null;
    }
    const seconds = Number(window.limit_window_seconds);
    const resetAt = Number(window.reset_at);
    return {
      usedPercent: Number(window.used_percent ?? 0),
      windowDurationMins: Number.isFinite(seconds) ? seconds / 60 : null,
      // Timestamps arrive in seconds; guard against a millisecond value anyway.
      resetsAt: Number.isFinite(resetAt) ? (resetAt > 1e12 ? resetAt / 1000 : resetAt) : null,
    };
  };
  // The app's own sidebar pill reads the reset count from this response as
  // well; the app refetches it right after redeeming a reset.
  const credits = usage.rate_limit_reset_credits;
  return {
    rateLimits: {
      primary: convert(windows.primary_window),
      secondary: convert(windows.secondary_window),
    },
    rateLimitResetCredits:
      credits != null && typeof credits === "object"
        ? { availableCount: Number(credits.available_count) }
        : null,
  };
}

function usageRows(response) {
  const snapshot = response?.rateLimits;
  if (snapshot == null) {
    return null;
  }
  const rows = [];
  for (const key of ["primary", "secondary"]) {
    const used = Number(snapshot[key]?.usedPercent);
    if (!Number.isFinite(used)) {
      continue;
    }
    const minutes = Number(snapshot[key].windowDurationMins);
    const resetsAt =
      snapshot[key].resetsAt == null ? Number.NaN : Number(snapshot[key].resetsAt);
    rows.push({
      percent: used,
      label: windowLabel(minutes),
      resetAt: Number.isFinite(resetsAt) ? resetsAt * 1000 : null,
      minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : Infinity,
    });
  }
  if (rows.length === 0) {
    return null;
  }
  // Ordering by window length rather than by the slot the backend reported keeps
  // the rows stable, and puts the window worth acting on first.
  rows.sort((left, right) => left.minutes - right.minutes);
  // Reset credits clear the account, so they ride the longest window instead of
  // implying they belong to the short one.
  const resets = availableResets(response);
  if (resets != null) {
    rows[rows.length - 1].resets = resets;
  }
  return rows.map(({ minutes, ...row }) => row);
}

function budgetRows(budget) {
  const formatAmount = (value) =>
    Number.isInteger(value) ? `${value}$` : `${value.toFixed(2)}$`;
  const resetAt = budget.resetAt == null ? Number.NaN : Date.parse(budget.resetAt);
  return [
    {
      percent: (budget.spend / budget.maxBudget) * 100,
      label: `${budget.spend.toFixed(2)}$ / ${formatAmount(budget.maxBudget)}`,
      resetAt: Number.isNaN(resetAt) ? null : resetAt,
    },
  ];
}

function writeFileAtomic(filePath, data, mode) {
  const temporaryPath = `${filePath}.profile-switcher-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, data, { encoding: "utf8", mode });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.unlinkSync(temporaryPath);
    }
  }
}

const AUTH_SYNC_INTERVAL_MS = 10000;

function authFilePath() {
  return path.join(codexHome(), "auth.json");
}

function accountsDir() {
  return path.join(codexHome(), ".codex-mod-accounts");
}

function accountSnapshotPath(accountId) {
  return path.join(accountsDir(), `${accountId}.json`);
}

function decodeJwtClaims(token) {
  try {
    const payload = token.split(".")[1];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof claims === "object" && claims != null ? claims : null;
  } catch {
    return null;
  }
}

function accountFromAuthJson(auth) {
  const tokens = auth?.tokens;
  const accountId = tokens?.account_id;
  if (typeof accountId !== "string" || accountId === "") {
    return null;
  }
  const claims = decodeJwtClaims(tokens.id_token ?? "") ?? {};
  const email = typeof claims.email === "string" ? claims.email : null;
  const name =
    typeof claims.name === "string" && claims.name.trim() !== ""
      ? claims.name.trim()
      : null;
  const plan = claims["https://api.openai.com/auth"]?.chatgpt_plan_type;
  const display = name ?? email;
  const label =
    display == null
      ? accountId
      : typeof plan === "string" && plan !== ""
        ? `${display} (${plan})`
        : display;
  return {
    accountId,
    label,
    name: display,
    plan: typeof plan === "string" && plan !== "" ? plan : null,
  };
}

function readAuthJson() {
  try {
    const parsed = JSON.parse(fs.readFileSync(authFilePath(), "utf8"));
    return typeof parsed === "object" && parsed != null ? parsed : null;
  } catch {
    return null;
  }
}

// Captures the live login into the account store and keeps the active
// account's snapshot fresh across token refreshes; refresh tokens are
// single-use, so a stale snapshot would force a fresh login.
function backUpActiveAccount() {
  const auth = readAuthJson();
  const account = accountFromAuthJson(auth);
  if (account == null) {
    return null;
  }
  const serialized = `${JSON.stringify(auth, null, 2)}\n`;
  const target = accountSnapshotPath(account.accountId);
  try {
    if (fs.readFileSync(target, "utf8") === serialized) {
      return account.accountId;
    }
  } catch {
    // No snapshot yet; write the first one below.
  }
  fs.mkdirSync(accountsDir(), { recursive: true, mode: 0o700 });
  writeFileAtomic(target, serialized, 0o600);
  return account.accountId;
}

function storedAccounts() {
  let entries;
  try {
    entries = fs.readdirSync(accountsDir()).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const accounts = [];
  for (const name of entries) {
    try {
      const auth = JSON.parse(fs.readFileSync(path.join(accountsDir(), name), "utf8"));
      const account = accountFromAuthJson(auth);
      if (account != null) {
        accounts.push(account);
      }
    } catch {
      continue;
    }
  }
  accounts.sort((left, right) => left.label.localeCompare(right.label));
  return accounts;
}

function writeAccount(accountId) {
  const serialized = fs.readFileSync(accountSnapshotPath(accountId), "utf8");
  if (accountFromAuthJson(JSON.parse(serialized)) == null) {
    throw new Error(`the stored login for ${accountId} is unreadable.`);
  }
  if (backUpActiveAccount() === accountId) {
    return false;
  }
  const authPath = authFilePath();
  const backupPath = `${authPath}.bak.before-profile-switcher`;
  if (fs.existsSync(authPath) && !fs.existsSync(backupPath)) {
    fs.copyFileSync(authPath, backupPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backupPath, 0o600);
  }
  writeFileAtomic(authPath, serialized, 0o600);
  return true;
}

function writeProvider(provider) {
  const configPath = path.join(codexHome(), "config.toml");
  const configText = fs.readFileSync(configPath, "utf8");
  if (!configuredProviders(configText).some((option) => option.provider === provider)) {
    throw new Error(`config.toml does not define model provider ${provider}.`);
  }

  const updated = rewriteModelProvider(configText, provider);
  if (updated === configText) {
    return false;
  }
  writeConfig(configPath, configText, updated);
  return true;
}

function writeConfig(configPath, previous, updated) {
  const stat = fs.statSync(configPath);
  const backupPath = `${configPath}.bak.before-profile-switcher`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(configPath, backupPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backupPath, stat.mode);
  }
  writeFileAtomic(configPath, updated, stat.mode);
  return updated !== previous;
}

function providerIdFromName(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Checks the add-profile form and returns either the section to append or
// the field errors to show again. `providers` holds the ids already in use.
function validateProviderInput(input, providers) {
  const values = {
    name: String(input?.name ?? "").trim(),
    baseUrl: String(input?.baseUrl ?? "").trim(),
    envKey: String(input?.envKey ?? "").trim(),
  };
  const errors = {};
  const provider = providerIdFromName(values.name);
  if (values.name === "") {
    errors.name = "Enter a name for the profile.";
  } else if (provider === "") {
    errors.name = "The name needs at least one letter or digit.";
  } else if (providers.includes(provider)) {
    errors.name = `A profile with the id "${provider}" already exists.`;
  }
  let url = null;
  try {
    url = new URL(values.baseUrl);
  } catch {
    url = null;
  }
  if (values.baseUrl === "") {
    errors.baseUrl = "Enter the base URL of the endpoint.";
  } else if (url == null || !/^https?:$/.test(url.protocol)) {
    errors.baseUrl = "Enter a full http:// or https:// URL.";
  }
  if (values.envKey !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(values.envKey)) {
    errors.envKey = "Use a variable name such as OPENAI_API_KEY.";
  }
  if (Object.keys(errors).length > 0) {
    return { values, errors };
  }
  return { values, provider, section: providerSectionText(provider, values) };
}

function tomlString(value) {
  return JSON.stringify(value);
}

function providerSectionText(provider, { name, baseUrl, envKey }) {
  const lines = [
    `[model_providers.${provider}]`,
    `name = ${tomlString(name)}`,
    `base_url = ${tomlString(baseUrl.replace(/\/+$/, ""))}`,
  ];
  if (envKey) {
    lines.push(`env_key = ${tomlString(envKey)}`);
  }
  lines.push("requires_openai_auth = false");
  return `${lines.join("\n")}\n`;
}

// Appends the section after the last `[model_providers.*]` table, or after
// the top-level header when there is none, so profiles stay grouped.
function appendProviderSection(configText, section) {
  const headers = [...configText.matchAll(/^\s*\[model_providers\.[^\]]+\]\s*$/gm)];
  let insertAt;
  if (headers.length > 0) {
    const last = headers[headers.length - 1];
    const rest = configText.slice(last.index + last[0].length);
    const next = rest.search(/^\s*\[/m);
    insertAt = next === -1 ? configText.length : last.index + last[0].length + next;
  } else {
    const first = configText.search(/^\s*\[/m);
    insertAt = first === -1 ? configText.length : first;
  }
  const before = configText.slice(0, insertAt).replace(/\s*$/, "");
  const after = configText.slice(insertAt).replace(/^\s*/, "");
  const head = before === "" ? "" : `${before}\n\n`;
  const tail = after === "" ? "" : `\n${after}`;
  return `${head}${section}${tail}`;
}

// Drops `[model_providers.<id>]` together with any `[model_providers.<id>.*]`
// sub-tables, each up to the next table header.
function removeProviderSection(configText, provider) {
  const escaped = provider.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  const header = new RegExp(`^\\s*\\[model_providers\\.${escaped}(?:\\.[^\\]]+)?\\]\\s*$`, "m");
  let text = configText;
  for (;;) {
    const match = header.exec(text);
    if (match == null) {
      break;
    }
    const rest = text.slice(match.index + match[0].length);
    const next = rest.search(/^\s*\[/m);
    const end = next === -1 ? text.length : match.index + match[0].length + next;
    const before = text.slice(0, match.index).replace(/\s*$/, "");
    const after = text.slice(end).replace(/^\s*/, "");
    text = before === "" ? after : after === "" ? `${before}\n` : `${before}\n\n${after}`;
  }
  return text;
}

function addProvider(input) {
  const configPath = path.join(codexHome(), "config.toml");
  const configText = fs.readFileSync(configPath, "utf8");
  const ids = configuredProviders(configText).map((option) => option.provider);
  const result = validateProviderInput(input, ids);
  if (result.errors != null) {
    return result;
  }
  writeConfig(configPath, configText, appendProviderSection(configText, result.section));
  return result;
}

function removeProvider(provider) {
  if (provider === OPENAI_PROVIDER) {
    throw new Error("The built-in OpenAI provider cannot be removed.");
  }
  const configPath = path.join(codexHome(), "config.toml");
  const configText = fs.readFileSync(configPath, "utf8");
  const updated = removeProviderSection(configText, provider);
  if (updated === configText) {
    return false;
  }
  return writeConfig(configPath, configText, updated);
}

// The patcher tags the buttons the mod attaches to. Where a page runs
// bundles without the tags, the label is matched against the translations
// the patcher collected from Codex's locale bundles, the live intl object,
// and the English label. The finder is stateless, so every install replaces
// the previous one with the current label table.
function anchorScript(labels = {}) {
  function installAnchorFinder(labelsByMessageId) {
    const attribute = "data-codex-mod-anchor";
    const anchors = {
      profileMenu: {
        kind: "profile-menu",
        id: "codex.profileFooter.openProfileMenu",
        fallback: "Open profile menu",
      },
      helpMenu: {
        kind: "help-menu",
        id: "sidebarHelp.openAriaLabel",
        fallback: "Open help menu",
      },
      signIn: {
        kind: "sign-in",
        id: "electron.onboarding.login.chatgpt.continueToSignIn",
        fallback: "Continue to sign in",
      },
      signInAlternative: {
        kind: "sign-in-alternative",
        id: "electron.onboarding.login.apikey.open.welcomeV2",
        fallback: "Sign in another way",
      },
    };

    function translate(id, fallback) {
      const message = globalThis.__codexIntl?.messages?.[id];
      return typeof message === "string" && message !== "" ? message : fallback;
    }

    function normalize(text) {
      return (text ?? "").trim().toLowerCase();
    }

    function matchesLabel(element, anchor) {
      const labels = new Set(
        [
          translate(anchor.id, anchor.fallback),
          anchor.fallback,
          ...(labelsByMessageId[anchor.id] ?? []),
        ].map(normalize),
      );
      return (
        labels.has(normalize(element.getAttribute("aria-label"))) ||
        labels.has(normalize(element.textContent))
      );
    }

    function findAll(name, root = document) {
      const anchor = anchors[name];
      const tagged = [...root.querySelectorAll(`[${attribute}="${anchor.kind}"]`)];
      if (tagged.length > 0) {
        return tagged;
      }
      return [...root.querySelectorAll("button")].filter((button) =>
        matchesLabel(button, anchor),
      );
    }

    globalThis.__codexModAnchors = {
      findAll,
      find(name, root = document) {
        return findAll(name, root)[0] ?? null;
      },
    };
  }

  return `(${installAnchorFinder.toString()})(${JSON.stringify(labels)})`;
}

function sidebarProfileScript(provider, providers, account, accounts, anchorLabels) {
  function installSidebarProfileSwitcher(
    initialProvider,
    initialProviders,
    initialAccount,
    initialAccounts,
  ) {
    const menuId = "codex-profile-switcher-menu";
    const loginPanelId = "codex-login-accounts";
    const styleId = "codex-profile-switcher-style";
    const openaiProvider = "openai";
    const requestPrefix = "__codex_profile_switch__:";
    const accountRequestPrefix = "__codex_account_switch__:";
    const addAccountRequest = "__codex_account_add__";
    const accountForgetPrefix = "__codex_account_forget__:";
    const addProfileRequest = "__codex_profile_add__";
    const profileRemovePrefix = "__codex_profile_remove__:";
    const activeProviderStorageKey = "__codex_active_provider";
    const anchors = globalThis.__codexModAnchors;
    const menuContentSelector = "[data-radix-menu-content]";
    const accountRowStorageKey = "__codex_profile_account_row";
    const existingController = globalThis.__codexProfileSidebarController;
    if (existingController != null) {
      existingController.setProviders(initialProviders);
      existingController.setAccounts(initialAccounts);
      existingController.setProvider(initialProvider);
      existingController.setAccount(initialAccount);
      existingController.ensure();
      return true;
    }

    let currentProvider = initialProvider;
    let providerOptions = initialProviders;
    let currentAccount = initialAccount ?? null;
    let accountOptions = Array.isArray(initialAccounts) ? initialAccounts : [];
    // Codex's menu header shows the signed-in account as an avatar with the
    // name and plan. That markup is remembered so account rows can reuse it,
    // also on the signed-out screen and under custom profiles, where no such
    // header is rendered.
    let accountRowMarkup = null;
    try {
      accountRowMarkup = localStorage.getItem(accountRowStorageKey);
    } catch {
      // Rows fall back to a single line until a header has been seen.
    }

    function persistProvider() {
      try {
        localStorage.setItem(activeProviderStorageKey, currentProvider);
      } catch {
        return;
      }
    }

    function providerLabel(value) {
      return providerOptions.find((option) => option.provider === value)?.label || value;
    }

    function accountLabel(value) {
      return accountOptions.find((option) => option.accountId === value)?.label || value;
    }

    function menuSignature() {
      return JSON.stringify([
        providerOptions.map((option) => [option.provider, option.label]),
        accountOptions.map((option) => [option.accountId, option.label]),
      ]);
    }

    function closeMenu() {
      const menu = document.getElementById(menuId);
      if (menu != null) {
        menu.hidden = true;
      }
      document
        .querySelector("[data-profile-toggle]")
        ?.setAttribute("aria-expanded", "false");
      document
        .querySelector(`#${loginPanelId} [data-login-toggle]`)
        ?.setAttribute("aria-expanded", "false");
    }

    // Codex's menu closes on a pointerdown on its trigger. A synthetic Escape
    // would close it too, but also reach the app's other Escape handlers.
    function findProfileButton() {
      return anchors.find("profileMenu");
    }

    function closeProfileMenu() {
      const trigger = findProfileButton();
      if (trigger?.getAttribute("aria-expanded") !== "true") {
        return;
      }
      trigger.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerType: "mouse",
          isPrimary: true,
        }),
      );
    }

    function closeMenus() {
      closeMenu();
      closeProfileMenu();
    }

    function renderProvider() {
      const menu = document.getElementById(menuId);
      if (menu != null && menu.dataset.signature !== menuSignature()) {
        populateMenu(menu);
      }

      document.querySelectorAll(`#${menuId} [data-account]`).forEach((option) => {
        // Accounts ride the built-in provider, so their row only highlights
        // while it is active; otherwise the active profile would be marked
        // twice.
        const selected =
          currentProvider === openaiProvider &&
          option.dataset.account === currentAccount;
        option.setAttribute("aria-selected", String(selected));
      });

      document.querySelectorAll(`#${menuId} [data-provider]`).forEach((option) => {
        const selected = option.dataset.provider === currentProvider;
        option.setAttribute("aria-selected", String(selected));
        const label = option.querySelector("[data-provider-label]");
        const labelText = providerLabel(option.dataset.provider);
        if (label != null && label.textContent !== labelText) {
          label.textContent = labelText;
        }
      });
    }

    function selectProvider(provider) {
      if (!providerOptions.some((option) => option.provider === provider)) {
        return;
      }
      const previousProvider = currentProvider;
      currentProvider = provider;
      renderProvider();
      closeMenus();
      try {
        if (globalThis.__codexProfileRequest?.(provider) !== true) {
          currentProvider = previousProvider;
          renderProvider();
        }
      } catch {
        currentProvider = previousProvider;
        renderProvider();
      }
    }

    function selectAccount(accountId) {
      if (!accountOptions.some((option) => option.accountId === accountId)) {
        return;
      }
      if (currentProvider === openaiProvider && currentAccount === accountId) {
        closeMenus();
        return;
      }
      const previousAccount = currentAccount;
      const previousProvider = currentProvider;
      currentAccount = accountId;
      currentProvider = openaiProvider;
      renderProvider();
      closeMenus();
      try {
        if (globalThis.__codexAccountRequest?.(accountId) !== true) {
          currentAccount = previousAccount;
          currentProvider = previousProvider;
          renderProvider();
        }
      } catch {
        currentAccount = previousAccount;
        currentProvider = previousProvider;
        renderProvider();
      }
    }

    function ensureStyle() {
      if (document.getElementById(styleId) != null) {
        return;
      }
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        /* Styled by attribute rather than by the stock item classes, which
           the app may rewrite while the menu is open. */
        [data-profile-toggle] {
          cursor: var(--cursor-interaction, pointer);
          padding-right: calc(var(--padding-row-x, 8px) + 24px);
          position: relative;
        }
        [data-profile-toggle]:hover,
        [data-profile-toggle][aria-expanded="true"] {
          background-color: var(
            --color-background-primary-ghost-hover,
            var(--color-token-list-hover-background, rgba(127, 127, 127, 0.14))
          );
        }
        /* The chevron is Codex's own submenu glyph, including its muted
           colour and the opacity lift on hover. */
        [data-profile-switch] {
          color: var(--color-text-tertiary, var(--color-codex-description, color-mix(in oklab, currentColor 55%, transparent)));
          display: flex;
          position: absolute;
          right: var(--padding-row-x, 8px);
          top: 50%;
          transform: translateY(-50%);
        }
        [data-profile-switch] svg {
          fill: currentColor;
          height: 16px;
          opacity: 0.75;
          width: 16px;
        }
        [data-profile-toggle]:hover [data-profile-switch] svg,
        [data-profile-toggle][aria-expanded="true"] [data-profile-switch] svg {
          opacity: 1;
        }
        #${menuId} {
          backdrop-filter: blur(var(--blur-sm, 8px));
          background: color-mix(in oklab, var(--color-token-dropdown-background, #2f2f2f) 90%, transparent);
          border-radius: var(--radius-xl, 12px);
          box-shadow: 0 0 0 0.5px var(--color-token-border, rgba(127, 127, 127, 0.28)),
            var(--shadow-xl, 0px 8px 16px -4px rgba(0, 0, 0, 0.12));
          color: var(--color-token-foreground, #f2f2f2);
          display: flex;
          flex-direction: column;
          min-width: 196px;
          padding: 4px;
          position: fixed;
          user-select: none;
          z-index: 2147483647;
          zoom: var(--codex-window-zoom, 1);
        }
        #${menuId}[hidden] { display: none; }
        #${menuId} button {
          align-items: center;
          background: transparent;
          border: 0;
          border-radius: var(--radius-lg, 10px);
          color: inherit;
          cursor: var(--cursor-interaction, default);
          display: flex;
          font: inherit;
          font-size: var(--text-sm, 0.8125rem);
          gap: 6px;
          line-height: var(--text-sm--line-height, 1.25rem);
          padding: var(--padding-row-y, 5px) var(--padding-row-x, 8px);
          text-align: left;
          width: 100%;
        }
        #${menuId} button:hover,
        #${menuId} button:focus-visible {
          background: var(--color-token-list-hover-background, rgba(127, 127, 127, 0.14));
          outline: none;
        }
        #${menuId} button[data-provider],
        #${menuId} button[data-account] {
          position: relative;
        }
        /* The active entry keeps a persistent filled row with a slightly
           stronger weight; hover uses the lighter list tint. */
        #${menuId} button[aria-selected="true"] {
          background: color-mix(in oklab, var(--color-token-foreground, #f2f2f2) 12%, transparent);
          font-weight: 500;
        }
        #${menuId} [data-provider-label],
        #${menuId} [data-account-label] {
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        /* Overlaid on the row's right edge so revealing it never widens the
           menu; long labels simply run underneath. */
        #${menuId} [data-row-remove] {
          z-index: 1;
          align-items: center;
          background: color-mix(in oklab, var(--color-token-foreground, #fff) 12%, var(--color-token-dropdown-background, #2f2f2f));
          border-radius: 4px;
          color: color-mix(in oklab, currentColor 62%, transparent);
          display: none;
          height: 16px;
          justify-content: center;
          position: absolute;
          right: 6px;
          top: 50%;
          transform: translateY(-50%);
          width: 16px;
        }
        #${menuId} button[data-account]:hover [data-row-remove],
        #${menuId} button[data-account]:focus-visible [data-row-remove],
        #${menuId} button[data-provider]:hover [data-row-remove],
        #${menuId} button[data-provider]:focus-visible [data-row-remove] {
          display: flex;
        }
        #${menuId} [data-row-remove]:hover {
          background: color-mix(in oklab, var(--color-token-foreground, #fff) 22%, var(--color-token-dropdown-background, #2f2f2f));
          color: var(--color-token-foreground, inherit);
        }
        #${menuId} [data-row-remove] svg {
          fill: none;
          height: 12px;
          stroke: currentColor;
          stroke-linecap: round;
          stroke-width: 1.7;
          width: 12px;
        }
        #${menuId} [data-menu-separator] {
          background: var(--color-token-border, rgba(127, 127, 127, 0.28));
          flex: none;
          height: 1px;
          margin: 4px 6px;
        }
        #${menuId} [data-menu-heading] {
          align-items: center;
          color: color-mix(in oklab, currentColor 55%, transparent);
          display: flex;
          font-size: var(--text-xs, 0.6875rem);
          gap: 6px;
          justify-content: space-between;
          line-height: 1.125rem;
          padding: 2px var(--padding-row-x, 8px) 1px;
          user-select: none;
        }
        #${menuId} button[data-menu-action] {
          border-radius: var(--radius-sm, 6px);
          color: inherit;
          flex: none;
          padding: 1px;
          width: auto;
        }
        #${menuId} button[data-menu-action]:hover,
        #${menuId} button[data-menu-action]:focus-visible {
          color: var(--color-token-foreground, inherit);
        }
        #${menuId}[data-login-context] button[data-menu-action] {
          display: none;
        }
        #${menuId} button[data-menu-action] svg {
          display: block;
          fill: none;
          height: 13px;
          stroke: currentColor;
          stroke-linecap: round;
          stroke-width: 1.6;
          width: 13px;
        }
        #${loginPanelId} {
          display: flex;
          flex-direction: column;
          margin-top: 12px;
          width: 100%;
        }
        #${loginPanelId} [data-login-toggle] {
          align-items: center;
          display: flex;
          gap: 6px;
          justify-content: center;
        }
        #${loginPanelId} [data-login-chevron] svg {
          display: block;
          fill: none;
          height: 14px;
          stroke: currentColor;
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-width: 1.7;
          transition: transform 0.15s ease;
          width: 14px;
        }
        #${loginPanelId} [data-login-toggle][aria-expanded="true"] [data-login-chevron] svg {
          transform: rotate(180deg);
        }
        #${loginPanelId} button[data-login-fallback] {
          background: transparent;
          border: 1px solid var(--color-token-border, rgba(127, 127, 127, 0.35));
          border-radius: 999px;
          color: inherit;
          cursor: var(--cursor-interaction, pointer);
          font: inherit;
          padding: 12px 16px;
          text-align: center;
          white-space: nowrap;
        }
        #${loginPanelId} button[data-login-fallback]:hover,
        #${loginPanelId} button[data-login-fallback]:focus-visible {
          background: var(--color-token-list-hover-background, rgba(127, 127, 127, 0.12));
          outline: none;
        }
      `;
      document.head.append(style);
    }

    // The avatar service draws initials from the file name of the image URL,
    // which is how Codex's own header gets its badge.
    function accountRowContent(details, label, text) {
      const template = document.createElement("template");
      template.innerHTML = accountRowMarkup;
      const content = template.content.firstElementChild;
      const lines = content?.querySelectorAll(".truncate") ?? [];
      const image = content?.querySelector("img");
      if (content == null || lines.length < 2 || image == null) {
        return null;
      }
      const name = details.name ?? label;
      const words = name.split(/\s+/).filter((word) => word !== "");
      const initials = [words[0], words.length > 1 ? words[words.length - 1] : null]
        .filter((word) => word != null)
        .map((word) => word[0])
        .join("")
        .toLowerCase();
      image.setAttribute(
        "src",
        image.getAttribute("src").replace(/[^/]*\.png(\?.*)?$/, `${encodeURIComponent(initials)}.png`),
      );
      text.setAttribute("class", lines[0].getAttribute("class"));
      text.textContent = name;
      lines[0].replaceWith(text);
      if (details.plan != null) {
        lines[1].textContent = details.plan[0].toUpperCase() + details.plan.slice(1);
      } else {
        lines[1].remove();
      }
      return content;
    }

    function menuOption(kind, value, label, onSelect, details = {}) {
      const option = document.createElement("button");
      option.type = "button";
      option.dataset[kind] = value;
      option.setAttribute("role", "option");
      const text = document.createElement("span");
      text.dataset[`${kind}Label`] = "";
      text.textContent = label;
      const accountRow =
        kind === "account" && accountRowMarkup != null
          ? accountRowContent(details, label, text)
          : null;
      option.append(accountRow ?? text);
      if (kind === "account" || kind === "provider") {
        const forget = document.createElement("span");
        forget.dataset.rowRemove = "";
        forget.setAttribute("role", "button");
        forget.setAttribute("aria-label", kind === "account" ? `Forget ${label}` : `Remove ${label}`);
        const forgetIcon = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "svg",
        );
        forgetIcon.setAttribute("viewBox", "0 0 16 16");
        forgetIcon.setAttribute("aria-hidden", "true");
        for (const pathData of ["m4.75 4.75 6.5 6.5", "m11.25 4.75-6.5 6.5"]) {
          const path = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "path",
          );
          path.setAttribute("d", pathData);
          forgetIcon.append(path);
        }
        forget.append(forgetIcon);
        forget.addEventListener("click", (event) => {
          event.stopPropagation();
          closeMenus();
          console.info(`${kind === "account" ? accountForgetPrefix : profileRemovePrefix}${value}`);
        });
        option.append(forget);
      }
      option.addEventListener("click", (event) => {
        event.stopPropagation();
        onSelect(value);
      });
      return option;
    }

    function menuHeading(label, action) {
      const element = document.createElement("div");
      element.dataset.menuHeading = "";
      const text = document.createElement("span");
      text.textContent = label;
      element.append(text);
      if (action != null) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.menuAction = "";
        button.setAttribute("aria-label", action.label);
        button.title = action.label;
        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon.setAttribute("viewBox", "0 0 16 16");
        icon.setAttribute("aria-hidden", "true");
        for (const pathData of ["M8 3.5v9", "M3.5 8h9"]) {
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("d", pathData);
          icon.append(path);
        }
        button.append(icon);
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          action.onSelect();
        });
        element.append(button);
      }
      return element;
    }

    // Each account entry stands for the built-in provider under that login,
    // so the plain provider entry only appears while no account is captured
    // yet.
    function requestAddAccount() {
      closeMenus();
      console.info(addAccountRequest);
    }

    function requestAddProfile() {
      closeMenus();
      console.info(addProfileRequest);
    }

    // The signed-out screen has no sidebar, so it gets its own pill list of
    // saved accounts and profiles under the sign-in card.
    function findLoginAnchor() {
      if (findProfileButton() != null) {
        return null;
      }
      return (
        anchors
          .findAll("signIn")
          .find((button) => button.getClientRects().length > 0) ?? null
      );
    }

    // The login toggle opens the same dropdown card the sidebar switcher
    // uses, so entries read as menu rows instead of more sign-in buttons.
    function cardMenu() {
      let menu = document.getElementById(menuId);
      if (menu == null) {
        menu = document.createElement("div");
        menu.id = menuId;
        menu.hidden = true;
        menu.setAttribute("role", "listbox");
        menu.setAttribute("aria-label", "Codex profile");
        // A pointerdown that reaches the document or moves focus would make
        // Codex's own menu dismiss itself while the card is used beside it.
        menu.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        document.body.append(menu);
      }
      return menu;
    }

    function menuZoom(menu) {
      // The card is zoomed to match the app UI, and left/top of a zoomed
      // fixed element are interpreted in that zoomed coordinate space.
      return menu.currentCSSZoom ?? (Number.parseFloat(getComputedStyle(menu).zoom) || 1);
    }

    function openLoginMenu(toggle) {
      const menu = cardMenu();
      // Adding an account from the signed-out screen is just signing in, so
      // the card's plus button stays hidden here.
      menu.setAttribute("data-login-context", "");
      if (menu.dataset.signature !== menuSignature()) {
        populateMenu(menu);
      }
      renderProvider();
      const opening = menu.hidden;
      closeMenu();
      if (!opening) {
        return;
      }
      const rect = toggle.getBoundingClientRect();
      menu.hidden = false;
      const zoom = menuZoom(menu);
      const menuRect = menu.getBoundingClientRect();
      const left = Math.min(
        Math.max(8, rect.left + (rect.width - menuRect.width) / 2),
        window.innerWidth - menuRect.width - 8,
      );
      const below = rect.bottom + 6;
      const top =
        below + menuRect.height + 8 <= window.innerHeight
          ? below
          : Math.max(8, rect.top - menuRect.height - 6);
      menu.style.left = `${left / zoom}px`;
      menu.style.top = `${top / zoom}px`;
      toggle.setAttribute("aria-expanded", "true");
    }

    function buildLoginToggle() {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.dataset.loginToggle = "";
      toggle.setAttribute("aria-haspopup", "listbox");
      toggle.setAttribute("aria-expanded", "false");
      const text = document.createElement("span");
      text.textContent = "Saved accounts";
      toggle.append(text);
      const chevron = document.createElement("span");
      chevron.dataset.loginChevron = "";
      const chevronIcon = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg",
      );
      chevronIcon.setAttribute("viewBox", "0 0 16 16");
      chevronIcon.setAttribute("aria-hidden", "true");
      const chevronPath = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      chevronPath.setAttribute("d", "m4.5 6.25 3.5 3.5 3.5-3.5");
      chevronIcon.append(chevronPath);
      chevron.append(chevronIcon);
      toggle.append(chevron);
      toggle.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openLoginMenu(toggle);
      });
      return toggle;
    }

    function ensureLoginPanel() {
      const anchor = findLoginAnchor();
      const existing = document.getElementById(loginPanelId);
      const hasEntries =
        accountOptions.length > 0 ||
        providerOptions.some((option) => option.provider !== openaiProvider);
      if (anchor == null || !hasEntries) {
        existing?.remove();
        return;
      }
      const host = anchor.parentElement;
      if (host == null) {
        return;
      }
      ensureStyle();
      const secondary = anchors
        .findAll("signInAlternative", host)
        .find((button) => button.dataset.loginToggle == null);
      let panel = existing;
      if (panel == null || panel.parentElement !== host) {
        panel?.remove();
        panel = document.createElement("div");
        panel.id = loginPanelId;
        panel.append(buildLoginToggle());
        // The panel joins the stock button stack right below "Sign in
        // another way" so it reads as one of the sign-in choices.
        let slot = secondary ?? anchor;
        while (slot.parentElement !== host && slot.parentElement != null) {
          slot = slot.parentElement;
        }
        slot.insertAdjacentElement("afterend", panel);
      }
      // The stock secondary button's own classes keep the toggle's size and
      // typography identical to its neighbors; own styling is the fallback.
      const toggle = panel.querySelector("[data-login-toggle]");
      const stockClass = secondary?.getAttribute("class") ?? null;
      if (toggle != null) {
        if (stockClass != null) {
          if (toggle.getAttribute("class") !== stockClass) {
            toggle.setAttribute("class", stockClass);
          }
          toggle.removeAttribute("data-login-fallback");
        } else if (!toggle.hasAttribute("data-login-fallback")) {
          toggle.setAttribute("data-login-fallback", "");
        }
      }
    }

    function populateMenu(menu) {
      const entries = [
        menuHeading("Accounts", { label: "Add account", onSelect: requestAddAccount }),
      ];
      if (accountOptions.length > 0) {
        for (const { accountId, label, name, plan } of accountOptions) {
          entries.push(menuOption("account", accountId, label, selectAccount, { name, plan }));
        }
      }
      const profiles = providerOptions.filter(
        (option) => option.provider !== openaiProvider,
      );
      // The sidebar always shows the Profiles heading so its plus button is
      // reachable; the signed-out card has no add action and skips an empty
      // group.
      if (profiles.length > 0 || !menu.hasAttribute("data-login-context")) {
        const separator = document.createElement("div");
        separator.dataset.menuSeparator = "";
        entries.push(
          separator,
          menuHeading("Profiles", { label: "Add profile", onSelect: requestAddProfile }),
        );
        for (const { provider, label } of profiles) {
          entries.push(menuOption("provider", provider, label, selectProvider));
        }
      }
      menu.dataset.signature = menuSignature();
      menu.replaceChildren(...entries);
    }

    function chevronIcon() {
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("viewBox", "0 0 20 20");
      icon.setAttribute("aria-hidden", "true");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute(
        "d",
        "M7.52925 3.7793C7.75652 3.55203 8.10803 3.52383 8.36616 3.69434L8.47065 3.7793L14.2207 9.5293C14.4804 9.789 14.4804 10.211 14.2207 10.4707L8.47065 16.2207C8.21095 16.4804 7.78895 16.4804 7.52925 16.2207C7.26955 15.961 7.26955 15.539 7.52925 15.2793L12.8085 10L7.52925 4.7207L7.44429 4.61621C7.27378 4.35808 7.30198 4.00657 7.52925 3.7793Z",
      );
      icon.append(path);
      return icon;
    }

    function findProfileMenu() {
      const trigger = findProfileButton();
      if (trigger == null || trigger.getAttribute("aria-expanded") !== "true") {
        return null;
      }
      if (trigger.id !== "") {
        const labelled = document.querySelector(
          `${menuContentSelector}[aria-labelledby="${CSS.escape(trigger.id)}"]`,
        );
        if (labelled != null) {
          return labelled;
        }
      }
      const open = document.querySelectorAll(`${menuContentSelector}[data-state="open"]`);
      return open.length === 1 ? open[0] : null;
    }

    // The card opens beside Codex's menu like a submenu, aligned with the
    // header row and flipped to the left when the window is too narrow.
    function openHeaderMenu(header) {
      const menu = cardMenu();
      menu.removeAttribute("data-login-context");
      if (menu.dataset.signature !== menuSignature()) {
        populateMenu(menu);
      }
      renderProvider();
      const opening = menu.hidden;
      closeMenu();
      if (!opening) {
        return;
      }
      const content = header.closest(menuContentSelector) ?? header;
      const contentRect = content.getBoundingClientRect();
      const rect = header.getBoundingClientRect();
      menu.hidden = false;
      const zoom = menuZoom(menu);
      const menuRect = menu.getBoundingClientRect();
      const right = contentRect.right + 4;
      const left =
        right + menuRect.width + 8 <= window.innerWidth
          ? right
          : Math.max(8, contentRect.left - menuRect.width - 4);
      const top = Math.max(8, Math.min(rect.top, window.innerHeight - menuRect.height - 8));
      menu.style.left = `${left / zoom}px`;
      menu.style.top = `${top / zoom}px`;
      header.setAttribute("aria-expanded", "true");
    }

    // Codex renders its profile menu afresh on every open. Its header row,
    // which the stock app leaves disabled, becomes the switcher's trigger.
    function ensureProfileMenu() {
      const menu = findProfileMenu();
      if (menu == null) {
        return;
      }
      const items = [...menu.querySelectorAll('[role="menuitem"]')];
      const header = items[0];
      if (header == null || header.dataset.profileToggle != null) {
        return;
      }
      ensureStyle();
      const headerRow = header.querySelector("[data-menu-row-content]");
      if (
        headerRow?.querySelector("img") != null &&
        headerRow.querySelectorAll(".truncate").length >= 2 &&
        headerRow.outerHTML !== accountRowMarkup
      ) {
        accountRowMarkup = headerRow.outerHTML;
        try {
          localStorage.setItem(accountRowStorageKey, accountRowMarkup);
        } catch {
          // Keep the in-memory markup even when persistence fails.
        }
        document.getElementById(menuId)?.removeAttribute("data-signature");
      }
      header.dataset.profileToggle = "";
      header.removeAttribute("aria-disabled");
      header.removeAttribute("data-disabled");
      header.setAttribute("aria-haspopup", "listbox");
      header.setAttribute("aria-expanded", "false");
      const chevron = document.createElement("span");
      chevron.dataset.profileSwitch = "";
      chevron.append(chevronIcon());
      header.append(chevron);
      header.addEventListener("click", (event) => {
        event.stopPropagation();
        openHeaderMenu(header);
      });
    }

    const controller = {
      ensure() {
        ensureProfileMenu();
        ensureLoginPanel();
      },
      setProvider(provider) {
        if (providerOptions.some((option) => option.provider === provider)) {
          currentProvider = provider;
          persistProvider();
          renderProvider();
        }
      },
      setProviders(providers) {
        if (!Array.isArray(providers) || providers.length === 0) {
          return;
        }
        providerOptions = providers;
        renderProvider();
      },
      setAccount(accountId) {
        currentAccount = accountId ?? null;
        renderProvider();
      },
      setAccounts(accounts) {
        if (!Array.isArray(accounts)) {
          return;
        }
        accountOptions = accounts;
        renderProvider();
      },
    };
    globalThis.__codexProfileSidebarController = controller;
    globalThis.__codexSetActiveProfile = controller.setProvider;
    globalThis.__codexSetActiveAccount = controller.setAccount;
    globalThis.__codexProfileRequest = (provider) => {
      if (!providerOptions.some((option) => option.provider === provider)) {
        return false;
      }
      console.info(`${requestPrefix}${provider}`);
      return true;
    };
    globalThis.__codexAccountRequest = (accountId) => {
      if (!accountOptions.some((option) => option.accountId === accountId)) {
        return false;
      }
      console.info(`${accountRequestPrefix}${accountId}`);
      return true;
    };

    document.addEventListener(
      "pointerdown",
      (event) => {
        const target = event.target instanceof Node ? event.target : null;
        if (
          target != null &&
          (document.getElementById(loginPanelId)?.contains(target) === true ||
            document.getElementById(menuId)?.contains(target) === true)
        ) {
          return;
        }
        closeMenu();
      },
      true,
    );
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    });
    window.addEventListener("resize", closeMenu);
    // The menu is portaled into the body, so its arrival shows up as an
    // added subtree there; the card closes along with the menu.
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && node.querySelector(menuContentSelector) != null) {
            closeMenu();
          }
        }
        for (const node of record.addedNodes) {
          if (
            node.nodeType === Node.ELEMENT_NODE &&
            (node.matches(menuContentSelector) ||
              node.querySelector(menuContentSelector) != null ||
              node.closest(menuContentSelector) != null)
          ) {
            ensureProfileMenu();
            return;
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
    persistProvider();
    ensureProfileMenu();
    ensureLoginPanel();
    const fastAttach = setInterval(() => {
      if (findProfileButton() != null || document.getElementById(loginPanelId) != null) {
        clearInterval(fastAttach);
        return;
      }
      ensureLoginPanel();
    }, 100);
    setInterval(ensureLoginPanel, 1500);
    return true;
  }

  return `${anchorScript(anchorLabels)};(${installSidebarProfileSwitcher.toString()})(${JSON.stringify(provider)},${JSON.stringify(providers)},${JSON.stringify(account ?? null)},${JSON.stringify(accounts ?? [])})`;
}

function sidebarBudgetScript(payload, anchorLabels) {
  function installSidebarBudget(initialPayload) {
    const boxId = "codex-budget-status";
    const styleId = "codex-budget-status-style";
    const existingController = globalThis.__codexBudgetController;
    if (existingController != null) {
      existingController.update(initialPayload);
      return true;
    }

    let currentPayload = initialPayload;

    function ensureStyle() {
      if (document.getElementById(styleId) != null) {
        return;
      }
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        #${boxId} {
          border-bottom: 1px solid var(--color-token-border, rgba(127, 127, 127, 0.28));
          color: var(--color-token-foreground, inherit);
          display: flex;
          flex: none;
          flex-direction: column;
          font-size: var(--text-sm, 0.8125rem);
          gap: 6px;
          line-height: var(--text-sm--line-height, 1.25rem);
          padding: 4px 10px 6px;
          user-select: none;
        }
        #${boxId} [data-budget-row] {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        #${boxId} [data-budget-bar-row] {
          align-items: center;
          display: flex;
          gap: 8px;
        }
        #${boxId} [data-budget-bar] {
          background: color-mix(in oklab, currentColor 16%, transparent);
          border-radius: 4px;
          flex: 1 1 auto;
          height: 8px;
          min-width: 32px;
          overflow: hidden;
        }
        #${boxId} [data-budget-fill] {
          border-radius: 4px;
          height: 100%;
          transition: width 0.3s ease;
        }
        #${boxId} [data-budget-percent] {
          flex: none;
          /* Reserved for the widest reading so the bar keeps one width. */
          font-variant-numeric: tabular-nums;
          min-width: 4.5ch;
          text-align: right;
        }
        #${boxId} [data-budget-amount-row] {
          display: flex;
          gap: 4px;
          justify-content: space-between;
          overflow: hidden;
          white-space: nowrap;
        }
        #${boxId} [data-budget-label-group] {
          align-items: center;
          display: flex;
          gap: 6px;
          min-width: 0;
          overflow: hidden;
        }
        #${boxId} [data-budget-resets] {
          background: var(--green-50, #d9f4e4);
          border: 0;
          border-radius: 999px;
          color: var(--green-700, #00692a);
          cursor: var(--cursor-interaction, pointer);
          flex: none;
          font: inherit;
          font-size: var(--text-xs, 0.6875rem);
          font-weight: 500;
          line-height: 1.125rem;
          padding: 0 7px;
        }
        :is(.dark, .electron-dark) #${boxId} [data-budget-resets] {
          background: var(--green-800, #004f1f);
          color: var(--green-50, #d9f4e4);
        }
        #${boxId} [data-budget-resets]:hover {
          filter: brightness(1.18);
        }
        #${boxId} [data-budget-resets]:focus-visible {
          outline: 2px solid var(--green-500, #00a240);
          outline-offset: 1px;
        }
        #${boxId} [data-budget-reset] {
          color: color-mix(in oklab, currentColor 62%, transparent);
        }
        #${boxId} [data-budget-row][data-stale] {
          opacity: 0.5;
        }
        #${boxId} [data-budget-notice] {
          color: color-mix(in oklab, currentColor 62%, transparent);
          font-size: var(--text-xs, 0.75rem);
          line-height: 1rem;
          overflow: hidden;
          padding: 3px 0;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        #${boxId} [data-budget-error] {
          align-items: center;
          background: color-mix(in oklab, #d64545 14%, transparent);
          border-radius: 6px;
          color: var(--red-500, #d64545);
          display: flex;
          font-size: var(--text-xs, 0.75rem);
          gap: 6px;
          line-height: 1rem;
          margin-bottom: 2px;
          min-width: 0;
          padding: 3px 7px;
        }
        #${boxId} [data-budget-error] svg {
          flex: none;
          height: 12px;
          width: 12px;
        }
        #${boxId} [data-budget-error-title] {
          font-weight: 600;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      `;
      document.head.append(style);
    }

    // The profile button is the reliable landmark; the help button gives way
    // to an Update pill while an app update is pending.
    function findFooterRow() {
      const anchors = globalThis.__codexModAnchors;
      const landmarks = [...anchors.findAll("profileMenu"), ...anchors.findAll("helpMenu")];
      for (const button of landmarks) {
        const row = button.closest(".h-toolbar");
        if (row != null && button.getClientRects().length > 0) {
          return row;
        }
      }
      return null;
    }

    function formatReset(epoch) {
      const delta = Math.max(0, epoch - Date.now());
      const days = Math.floor(delta / 86400000);
      const hours = Math.floor((delta % 86400000) / 3600000);
      if (days > 0) {
        return `${days}d ${hours}h`;
      }
      const minutes = Math.floor((delta % 3600000) / 60000);
      return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    }

    function createRow() {
      const row = document.createElement("div");
      row.dataset.budgetRow = "";
      const barRow = document.createElement("div");
      barRow.dataset.budgetBarRow = "";
      const bar = document.createElement("div");
      bar.dataset.budgetBar = "";
      const fill = document.createElement("div");
      fill.dataset.budgetFill = "";
      bar.append(fill);
      const percent = document.createElement("span");
      percent.dataset.budgetPercent = "";
      barRow.append(bar, percent);
      const amountRow = document.createElement("div");
      amountRow.dataset.budgetAmountRow = "";
      const labelGroup = document.createElement("span");
      labelGroup.dataset.budgetLabelGroup = "";
      const amounts = document.createElement("span");
      amounts.dataset.budgetAmounts = "";
      const resets = document.createElement("button");
      resets.type = "button";
      resets.dataset.budgetResets = "";
      resets.hidden = true;
      resets.addEventListener("click", (event) => {
        event.stopPropagation();
        globalThis.__codexOpenUsageResets?.();
      });
      labelGroup.append(amounts, resets);
      const reset = document.createElement("span");
      reset.dataset.budgetReset = "";
      amountRow.append(labelGroup, reset);
      row.append(barRow, amountRow);
      return row;
    }

    function renderRow(element, row) {
      const percentage = Math.min(100, Math.max(0, row.percent));
      const color =
        percentage >= 90 ? "#d64545" : percentage >= 70 ? "#df8f3d" : "#4d9e6f";
      const fill = element.querySelector("[data-budget-fill]");
      fill.style.width = `${percentage}%`;
      fill.style.background = color;
      element.querySelector("[data-budget-percent]").textContent =
        `${Math.round(percentage)}%`;
      element.querySelector("[data-budget-amounts]").textContent = row.label;
      const resetsButton = element.querySelector("[data-budget-resets]");
      // Without the renderer bridge the pill would be a dead button, so it only
      // appears once the bridge is in place.
      const openable = typeof globalThis.__codexOpenUsageResets === "function";
      resetsButton.hidden = !(openable && row.resets > 0);
      if (!resetsButton.hidden) {
        const label = row.resets === 1 ? "1 reset" : `${row.resets} resets`;
        resetsButton.textContent = label;
        resetsButton.setAttribute("aria-label", `${label} available. Open usage resets`);
      }
      const resetElement = element.querySelector("[data-budget-reset]");
      // A window only starts counting down with the first message, so an
      // untouched window would otherwise look like it resets after a full
      // period from now.
      resetElement.textContent =
        row.resetAt == null
          ? ""
          : row.percent <= 0
            ? "not started"
            : `resets in ${formatReset(row.resetAt)}`;
      const amountRow = element.querySelector("[data-budget-amount-row]");
      if (resetElement.textContent !== "" && amountRow.scrollWidth > amountRow.clientWidth) {
        resetElement.textContent = "";
      }
    }

    function render() {
      const rows = currentPayload?.rows ?? [];
      const error = typeof currentPayload?.error === "string" ? currentPayload.error : null;
      const notice = typeof currentPayload?.notice === "string" ? currentPayload.notice : null;
      if (rows.length === 0 && error == null && notice == null) {
        document.getElementById(boxId)?.remove();
        return;
      }
      const footerRow = findFooterRow();
      if (footerRow?.parentElement == null) {
        return;
      }
      ensureStyle();

      let box = document.getElementById(boxId);
      if (box == null || box.nextElementSibling !== footerRow) {
        box?.remove();
        box = document.createElement("div");
        box.id = boxId;
        footerRow.parentElement.insertBefore(box, footerRow);
      }
      let rowElements = [...box.querySelectorAll("[data-budget-row]")];
      if (rowElements.length !== rows.length) {
        for (const element of rowElements) {
          element.remove();
        }
        rowElements = rows.map(createRow);
        box.append(...rowElements);
      }
      rows.forEach((row, index) => {
        const element = rowElements[index];
        renderRow(element, row);
        element.toggleAttribute("data-stale", error != null);
      });

      // A failed refresh keeps the last known rows, dimmed, and explains the
      // failure in an alert underneath instead of leaving the user guessing
      // where the box went.
      // A profile without a usage source gets a quiet note instead.
      let noticeElement = box.querySelector("[data-budget-notice]");
      if (notice == null || error != null) {
        noticeElement?.remove();
      } else {
        if (noticeElement == null) {
          noticeElement = document.createElement("div");
          noticeElement.dataset.budgetNotice = "";
        }
        if (noticeElement.textContent !== notice) {
          noticeElement.textContent = notice;
        }
        if (box.firstElementChild !== noticeElement) {
          box.prepend(noticeElement);
        }
      }
      let errorElement = box.querySelector("[data-budget-error]");
      if (error == null) {
        errorElement?.remove();
        return;
      }
      if (errorElement == null) {
        errorElement = createErrorElement();
      }
      const title = "Error fetching usage";
      const detail = error.charAt(0).toUpperCase() + error.slice(1);
      const titleElement = errorElement.querySelector("[data-budget-error-title]");
      if (titleElement.textContent !== title) {
        titleElement.textContent = title;
      }
      // The reason stays one hover away; a single line keeps the box compact.
      if (errorElement.title !== detail) {
        errorElement.title = detail;
        errorElement.setAttribute("aria-label", `${title}: ${detail}`);
      }
      if (box.firstElementChild !== errorElement) {
        box.prepend(errorElement);
      }
    }

    function createErrorElement() {
      const element = document.createElement("div");
      element.dataset.budgetError = "";
      element.setAttribute("role", "alert");
      const svgNamespace = "http://www.w3.org/2000/svg";
      const icon = document.createElementNS(svgNamespace, "svg");
      icon.setAttribute("viewBox", "0 0 16 16");
      icon.setAttribute("aria-hidden", "true");
      const shape = document.createElementNS(svgNamespace, "path");
      shape.setAttribute("fill", "currentColor");
      shape.setAttribute(
        "d",
        "M8 1.5 15 14H1L8 1.5Zm0 3.2L3.3 12.6h9.4L8 4.7Zm-.75 3.3h1.5v3h-1.5v-3Zm0 3.8h1.5v1.5h-1.5V11.8Z",
      );
      icon.append(shape);
      const title = document.createElement("span");
      title.dataset.budgetErrorTitle = "";
      element.append(icon, title);
      return element;
    }

    const controller = {
      ensure: render,
      update(payload) {
        currentPayload = payload;
        render();
      },
    };
    globalThis.__codexBudgetController = controller;
    globalThis.__codexBudgetUpdate = controller.update;
    // The patched renderer hands over each usage response the app fetches for
    // its own display; the host turns it into rows for every window.
    const report = (prefix) => (payload) => {
      try {
        console.log(`${prefix}:${JSON.stringify(payload ?? null)}`);
      } catch {
        // A payload that cannot be serialized is not worth reporting.
      }
    };
    globalThis.__codexReportRateLimits = report("__codex_rate_limits__");
    render();
    setInterval(render, 1500);
    return true;
  }

  return `${anchorScript(anchorLabels)};(${installSidebarBudget.toString()})(${JSON.stringify(payload)})`;
}

// In-app replacement for the host's native dialogs: a modal in the Codex
// window styled like the app's own, resolving to the index of the pressed
// button. The host awaits it over DevTools and falls back to a native dialog
// when no window is attached.
function modalScript() {
  function installModal() {
    if (typeof globalThis.__codexShowModal === "function") {
      return true;
    }
    const overlayClass = "codex-mod-modal";
    const buttonBase =
      "no-drag cursor-interaction items-center select-none focus:outline-none " +
      "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 gap-1 " +
      "border whitespace-nowrap flex rounded-lg h-token-button-composer px-3 py-0 " +
      "text-base leading-[18px]";
    const variants = {
      primary:
        "border-default bg-primary-solid enabled:hover:bg-text/80 text-primary-solid",
      secondary: "text-default bg-text/5 enabled:hover:bg-text/10 border-transparent",
      danger: "bg-chart-red/10 enabled:hover:bg-chart-red/20 text-chart-red border-transparent",
    };

    function showModal(options) {
      const {
        message,
        detail = "",
        buttons = ["OK"],
        defaultId = 0,
        cancelId = null,
        destructiveId = null,
        fields = [],
        errors = {},
        links = [],
      } = options ?? {};
      const hasForm = fields.length > 0;
      return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = overlayClass;
        Object.assign(overlay.style, {
          alignItems: "center",
          background: "rgba(0, 0, 0, 0.45)",
          display: "flex",
          inset: "0",
          justifyContent: "center",
          padding: "24px",
          position: "fixed",
          zIndex: "2147483000",
        });
        const dialog = document.createElement("div");
        dialog.setAttribute("role", cancelId == null ? "dialog" : "alertdialog");
        dialog.setAttribute("aria-modal", "true");
        dialog.className = "rounded-2xl border border-default shadow-2xl";
        Object.assign(dialog.style, {
          backgroundColor:
            "var(--color-background-panel, var(--color-background-primary-soft-alpha))",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          maxWidth: "24rem",
          padding: "20px",
          width: "100%",
        });
        const title = document.createElement("div");
        title.className = "text-base font-medium text-default";
        title.textContent = message;
        dialog.setAttribute("aria-label", message);
        const body = document.createElement("div");
        body.className = "text-sm leading-5 text-secondary";
        body.style.whiteSpace = "pre-line";
        body.textContent = detail;
        const actions = document.createElement("div");
        Object.assign(actions.style, {
          alignItems: "center",
          display: "flex",
          gap: "8px",
          justifyContent: "flex-end",
        });
        // A form modal resolves to the pressed button plus the field values;
        // a plain one keeps resolving to the button index alone.
        const form = document.createElement("div");
        Object.assign(form.style, { display: "flex", flexDirection: "column", gap: "12px" });
        const inputs = new Map();
        for (const field of fields) {
          const group = document.createElement("label");
          Object.assign(group.style, { display: "flex", flexDirection: "column", gap: "6px" });
          const caption = document.createElement("span");
          caption.className = "text-sm text-default";
          caption.textContent = field.label;
          const input = document.createElement("input");
          input.type = "text";
          input.autocomplete = "off";
          input.spellcheck = false;
          input.placeholder = field.placeholder ?? "";
          input.value = field.value ?? "";
          input.setAttribute("aria-label", field.label);
          // Same classes and metrics as the text inputs in Settings; the
          // font family is inherited while the size comes from `text-sm`.
          input.className = "text-sm leading-5 text-default";
          const restingBorder = "var(--color-token-border, rgba(127, 127, 127, 0.28))";
          const focusedBorder =
            "color-mix(in oklab, var(--color-token-foreground, #f2f2f2) 35%, transparent)";
          Object.assign(input.style, {
            background: "var(--color-token-input-background, rgba(127, 127, 127, 0.12))",
            border: `1px solid ${restingBorder}`,
            borderRadius: "8px",
            boxSizing: "border-box",
            color: "inherit",
            fontFamily: "inherit",
            margin: "0",
            outline: "none",
            padding: "6px 8px",
            width: "100%",
          });
          input.addEventListener("focus", () => {
            input.style.borderColor = focusedBorder;
          });
          input.addEventListener("blur", () => {
            input.style.borderColor = restingBorder;
          });
          inputs.set(field.name, input);
          group.append(caption, input);
          const error = errors[field.name];
          if (error) {
            const note = document.createElement("span");
            note.className = "text-xs text-chart-red";
            note.textContent = error;
            input.setAttribute("aria-invalid", "true");
            group.append(note);
          } else if (field.hint) {
            const note = document.createElement("span");
            note.className = "text-xs text-secondary";
            note.textContent = field.hint;
            group.append(note);
          }
          form.append(group);
        }
        const values = () =>
          Object.fromEntries([...inputs].map(([name, input]) => [name, input.value]));
        let settled = false;
        const finish = (index) => {
          if (settled) {
            return;
          }
          settled = true;
          document.removeEventListener("keydown", onKey, true);
          overlay.remove();
          resolve(hasForm ? { button: index, values: values() } : index);
        };
        const onKey = (event) => {
          if (event.key === "Escape" && cancelId != null) {
            event.stopPropagation();
            event.preventDefault();
            finish(cancelId);
          } else if (event.key === "Enter") {
            event.stopPropagation();
            event.preventDefault();
            finish(defaultId);
          }
        };
        const elements = buttons.map((label, index) => {
          const button = document.createElement("button");
          button.type = "button";
          // The cancel button is never emphasized, even when Enter picks it.
          const variant =
            index === destructiveId
              ? "danger"
              : index === defaultId && index !== cancelId
                ? "primary"
                : "secondary";
          button.className = `${buttonBase} ${variants[variant]}`;
          button.textContent = label;
          button.addEventListener("click", () => finish(index));
          return button;
        });
        overlay.addEventListener("click", (event) => {
          if (event.target === overlay && cancelId != null) {
            finish(cancelId);
          }
        });
        overlay.dismiss = () => finish(cancelId ?? defaultId);
        document.addEventListener("keydown", onKey, true);
        // Links sit on the left of the button row and resolve to their id
        // instead of a button index, for secondary paths such as opening
        // the config file.
        for (const link of links) {
          const anchor = document.createElement("button");
          anchor.type = "button";
          anchor.className = "text-xs text-secondary";
          Object.assign(anchor.style, {
            background: "transparent",
            border: "0",
            cursor: "var(--cursor-interaction, default)",
            fontFamily: "inherit",
            marginRight: "auto",
            padding: "0",
            textDecoration: "underline",
            textUnderlineOffset: "2px",
          });
          anchor.textContent = link.label;
          anchor.addEventListener("click", () => finish(link.id));
          actions.append(anchor);
        }
        actions.append(...elements);
        const parts = [title];
        if (detail !== "") {
          parts.push(body);
        }
        if (hasForm) {
          parts.push(form);
        }
        parts.push(actions);
        dialog.append(...parts);
        overlay.append(dialog);
        document.body.append(overlay);
        if (hasForm) {
          const firstInvalid = fields.find((field) => errors[field.name]);
          (inputs.get(firstInvalid?.name) ?? inputs.values().next().value)?.focus();
        } else {
          (elements[cancelId ?? defaultId] ?? elements[0])?.focus();
        }
      });
    }

    globalThis.__codexShowModal = showModal;
    globalThis.__codexDismissModals = () => {
      for (const overlay of document.querySelectorAll(`.${overlayClass}`)) {
        overlay.dismiss?.();
      }
    };
    return true;
  }

  return `(${installModal.toString()})()`;
}

// Resolves to true once the thread's transcript is on screen, opening it
// through its sidebar entry when another view is showing.
// The thread the main window shows, read from the sidebar's active entry;
// null on the new-chat page and other views.
// Whether the host has rendered its controls into the current document. The
// sidebar controller only exists on a page that loaded under the host's
// interception, so it also tells that the page runs the patched bundles.
// Whether the page runs the patched bundles; the injected controls alone do
// not count, since the host renders them into stock pages as well.
function modPresentScript() {
  return "globalThis.__codexModBundles === true";
}

function activeThreadScript() {
  return `(document.querySelector('[data-app-action-sidebar-thread-active="true"]')
    ?.getAttribute("data-app-action-sidebar-thread-id")
    ?.replace(/^local:/, "") ?? null)`;
}

function showThreadScript(threadId) {
  const active = `[data-app-action-sidebar-thread-id="local:${threadId}"][data-app-action-sidebar-thread-active="true"]`;
  const entry = `[data-app-action-sidebar-thread-id="local:${threadId}"]`;
  return `(() => {
    const shown = () => document.querySelector(${JSON.stringify(active)}) != null;
    if (shown()) return true;
    const entry = document.querySelector(${JSON.stringify(entry)});
    if (entry == null) return false;
    entry.click();
    return new Promise((resolve) => {
      const deadline = Date.now() + 5000;
      const tick = () => {
        if (shown()) resolve(true);
        else if (Date.now() > deadline) resolve(false);
        else setTimeout(tick, 100);
      };
      tick();
    });
  })()`;
}

// Sends the failed message again through the action behind Codex's own
// "Edit message" button, so Codex replaces the failed turn with a new
// rollout segment instead of appending a second copy. Resolves to "sent",
// to "missing" when the bridge is not installed, or to the action's error.
function editLastTurnScript(threadId, turnId, text) {
  return `(async () => {
    const edit = globalThis.__codexEditLastTurn;
    if (typeof edit !== "function") return "missing";
    try {
      await edit(${JSON.stringify(threadId)}, {
        turnId: ${JSON.stringify(turnId)},
        message: ${JSON.stringify(text)},
        shouldSendPermissionOverrides: false,
      });
      return "sent";
    } catch (error) {
      return "error: " + String(error?.message ?? error);
    }
  })()`;
}

const composerSelector = '[data-codex-composer="true"]';

function focusComposerScript() {
  return `(() => {
    const composer = [...document.querySelectorAll(${JSON.stringify(composerSelector)})]
      .find((element) => element.getClientRects().length > 0);
    if (composer == null) return false;
    composer.focus();
    return document.activeElement === composer;
  })()`;
}

function composerTextScript() {
  return `(() => {
    const composer = [...document.querySelectorAll(${JSON.stringify(composerSelector)})]
      .find((element) => element.getClientRects().length > 0);
    return composer == null ? null : composer.textContent;
  })()`;
}

function modalPromptScript(options) {
  return (
    "typeof globalThis.__codexShowModal===\"function\"" +
    `?globalThis.__codexShowModal(${JSON.stringify(options)}):undefined`
  );
}

// A "Codex Mod" section at the bottom of Settings > General that names the
// release the host is serving, so a user can tell which version they run.
function settingsVersionScript(version, describe) {
  function installSettingsVersion(release, build) {
    const sectionId = "codex-mod-version";
    const existing = globalThis.__codexVersionController;
    if (existing != null) {
      existing.update(release, build);
      return true;
    }
    let currentRelease = release;
    let currentBuild = build;

    // The General page is the first entry of the settings navigation; matching
    // on its position rather than its title keeps this locale independent.
    function generalPageSections() {
      const nav = document.querySelector("nav.sidebar-navigation");
      if (nav == null) {
        return null;
      }
      const entries = [...nav.querySelectorAll("button, a")];
      const current = entries.find((entry) => entry.getAttribute("aria-current") === "page");
      if (current == null || entries.indexOf(current) !== 1) {
        return null;
      }
      const heading = [...document.querySelectorAll("h1")].find(
        (h1) => h1.getClientRects().length > 0 && h1.closest("nav") == null,
      );
      const page = heading?.closest(".mx-auto");
      if (page == null) {
        return null;
      }
      return (
        [...page.children].findLast(
          (child) => child.tagName === "DIV" && child.querySelector("section") != null,
        ) ?? null
      );
    }

    function buildLabel() {
      return currentBuild && currentBuild !== currentRelease
        ? `${currentRelease} (${currentBuild})`
        : currentRelease;
    }

    function createSection() {
      const section = document.createElement("section");
      section.id = sectionId;
      section.className = "flex flex-col";
      const header = document.createElement("div");
      header.className = "flex justify-between gap-4 min-h-toolbar items-center pb-1.5";
      const title = document.createElement("div");
      title.className = "font-medium text-default text-base";
      title.textContent = "Codex Mod";
      header.append(title);
      const card = document.createElement("div");
      card.className = "flex flex-col rounded-2xl overflow-hidden border border-default";
      card.style.backgroundColor =
        "var(--color-background-panel, var(--color-background-primary-soft-alpha))";
      const row = document.createElement("div");
      row.className = "flex items-center justify-between px-4 gap-6 py-3";
      const text = document.createElement("div");
      text.className = "flex min-w-0 flex-1 flex-col gap-0.5";
      const label = document.createElement("div");
      label.className = "min-w-0 text-sm text-default font-medium";
      label.textContent = "Version";
      const detail = document.createElement("div");
      detail.className = "min-w-0 text-xs leading-4 text-secondary";
      detail.textContent = "The release the mod host serves to this window";
      text.append(label, detail);
      const value = document.createElement("div");
      value.dataset.codexModVersion = "";
      value.className = "shrink-0 text-sm text-secondary tabular-nums";
      row.append(text, value);
      card.append(row, createUninstallRow());
      section.append(header, card);
      return section;
    }

    function createUninstallRow() {
      const row = document.createElement("div");
      row.className = "flex items-center justify-between px-4 gap-6 py-3 border-t border-default";
      const text = document.createElement("div");
      text.className = "flex min-w-0 flex-1 flex-col gap-0.5";
      const label = document.createElement("div");
      label.className = "min-w-0 text-sm text-default font-medium";
      label.textContent = "Uninstall";
      const detail = document.createElement("div");
      detail.className = "min-w-0 text-xs leading-4 text-secondary";
      detail.textContent = "Removes Codex Mod entirely and restarts Codex";
      text.append(label, detail);
      const button = document.createElement("button");
      button.type = "button";
      button.className =
        "no-drag cursor-interaction items-center select-none focus:outline-none " +
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 gap-1 " +
        "border whitespace-nowrap flex rounded-lg bg-chart-red/10 " +
        "enabled:hover:bg-chart-red/20 text-chart-red border-transparent " +
        "h-token-button-composer px-2 py-0 text-base leading-[18px] shrink-0";
      button.textContent = "Uninstall";
      button.addEventListener("click", () => {
        openUninstallConfirmation();
      });
      row.append(text, button);
      return row;
    }

    // The confirmation lives in the page so its Uninstall button can carry
    // the app's own destructive styling; a native dialog has no red button.
    function openUninstallConfirmation() {
      const show = globalThis.__codexShowModal;
      if (typeof show !== "function") {
        return;
      }
      void show({
        message: "Uninstall Codex Mod?",
        detail:
          "This removes Codex Mod and restarts Codex. Running threads stop. " +
          "Saved account logins are kept.",
        buttons: ["Cancel", "Uninstall"],
        defaultId: 0,
        cancelId: 0,
        destructiveId: 1,
      }).then((index) => {
        if (index === 1) {
          console.log("__codex_mod_uninstall__");
        }
      });
    }

    function render() {
      const sections = generalPageSections();
      let section = document.getElementById(sectionId);
      if (sections == null) {
        section?.remove();
        return;
      }
      if (section == null || section.parentElement !== sections) {
        section?.remove();
        section = createSection();
        sections.append(section);
      } else if (sections.lastElementChild !== section) {
        sections.append(section);
      }
      const value = section.querySelector("[data-codex-mod-version]");
      const labelText = buildLabel();
      if (value.textContent !== labelText) {
        value.textContent = labelText;
      }
    }

    globalThis.__codexVersionController = {
      update(nextRelease, nextBuild) {
        currentRelease = nextRelease;
        currentBuild = nextBuild;
        render();
      },
    };
    render();
    setInterval(render, 1500);
    return true;
  }

  return `(${installSettingsVersion.toString()})(${JSON.stringify(version)},${JSON.stringify(describe ?? null)})`;
}

function activeProviderSyncScript(provider) {
  const serialized = JSON.stringify(provider);
  return `try{localStorage.setItem("__codex_active_provider",${serialized})}catch{}`;
}

module.exports = {
  OPENAI_PROVIDER,
  AUTH_SYNC_INTERVAL_MS,
  BUDGET_POLL_INTERVAL_MS,
  USAGE_POLL_INTERVAL_MS,
  LIVE_USAGE_TRUST_MS,
  accountSnapshotPath,
  activeProvider,
  activeProviderSyncScript,
  authFilePath,
  backUpActiveAccount,
  budgetRows,
  codexHome,
  configuredProviders,
  fetchBudget,
  providerBudgetSource,
  readAccountRateLimits,
  isRevokedTokenError,
  modPresentScript,
  rateLimitsFromUsage,
  readAuthJson,
  sidebarBudgetScript,
  settingsVersionScript,
  modalScript,
  modalPromptScript,
  activeThreadScript,
  showThreadScript,
  editLastTurnScript,
  focusComposerScript,
  composerTextScript,
  sidebarProfileScript,
  storedAccounts,
  usageRows,
  writeAccount,
  writeProvider,
  addProvider,
  removeProvider,
  appendProviderSection,
  removeProviderSection,
  validateProviderInput,
  providerIdFromName,
};
