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
    const baseUrl = section.match(/^\s*base_url\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m)?.[1];
    let host = null;
    try {
      host = baseUrl == null ? null : new URL(baseUrl).host || null;
    } catch {
      // A malformed base URL leaves the row without a subtitle.
    }
    providers.push({ provider, label: name?.trim() || provider, host });
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
// Single calls fail now and then and recover on the next poll, so a refresh
// failure only reaches the sidebar once this many polls in a row failed.
const FAILED_POLLS_BEFORE_ALERT = 3;

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

// Newer builds ship the CLI as a nested app under codex-cli; older ones
// placed the binary directly in Resources.
function codexBinary() {
  const candidates = ["/Applications/ChatGPT.app", "/Applications/Codex.app"].flatMap((app) => [
    `${app}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`,
    `${app}/Contents/Resources/codex`,
  ]);
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
  const limit = usage?.spend_control?.individual_limit;
  const hasWindows = windows != null && typeof windows === "object";
  const hasLimit = limit != null && typeof limit === "object";
  if (!hasWindows && !hasLimit) {
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
      primary: hasWindows ? convert(windows.primary_window) : null,
      secondary: hasWindows ? convert(windows.secondary_window) : null,
      individualLimit: hasLimit
        ? { limit: limit.limit, used: limit.used, resetsAt: limit.reset_at }
        : null,
    },
    rateLimitResetCredits:
      credits != null && typeof credits === "object"
        ? { availableCount: Number(credits.available_count) }
        : null,
  };
}

function formatCredits(amount) {
  return Math.round(amount).toLocaleString("en-US");
}

// A workspace admin can cap each member's monthly credits; that cap applies
// on top of the rate-limit windows, or alone when the plan has none.
function individualLimitRow(limit) {
  const used = Number(limit?.used);
  const total = Number(limit?.limit);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    return null;
  }
  const resetsAt = limit.resetsAt == null ? Number.NaN : Number(limit.resetsAt);
  return {
    kind: "budget",
    percent: (used / total) * 100,
    label: `${formatCredits(used)} / ${formatCredits(total)} credits`,
    resetAt: Number.isFinite(resetsAt) ? resetsAt * 1000 : null,
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
  const limitRow = individualLimitRow(snapshot.individualLimit);
  if (rows.length === 0 && limitRow == null) {
    return null;
  }
  // Ordering by window length rather than by the slot the backend reported keeps
  // the rows stable, and puts the window worth acting on first.
  rows.sort((left, right) => left.minutes - right.minutes);
  // Reset credits clear the rate-limit windows, so they ride the longest window
  // instead of implying they belong to the short one or to the credit limit.
  const resets = availableResets(response);
  if (resets != null && rows.length > 0) {
    rows[rows.length - 1].resets = resets;
  }
  const windowRows = rows.map(({ minutes, ...row }) => row);
  return limitRow == null ? windowRows : [...windowRows, limitRow];
}

function budgetRows(budget) {
  const resetAt = budget.resetAt == null ? Number.NaN : Date.parse(budget.resetAt);
  return [
    {
      kind: "budget",
      percent: (budget.spend / budget.maxBudget) * 100,
      label: `${budget.spend.toFixed(2)}$ / ${budget.maxBudget.toFixed(2)}$`,
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

// The plan names Codex shows under the account in its profile menu.
const PLAN_NAMES = {
  business: "Enterprise",
  enterprise: "Enterprise",
  enterprise_cbp_automation: "Enterprise",
  enterprise_cbp_usage_based: "Enterprise",
  ent26: "Enterprise",
  free: "Free",
  free_workspace: "Free",
  go: "Go",
  guest: "Free",
  plus: "Plus",
  pro: "Pro",
  promax: "Pro",
  prolite: "Pro",
  self_serve_business_prolite: "Business",
  self_serve_business_usage_based: "Business",
  team: "Business",
};

function planName(plan) {
  if (typeof plan !== "string" || plan === "") {
    return null;
  }
  return PLAN_NAMES[plan] ?? plan[0].toUpperCase() + plan.slice(1);
}

// A saved login belongs to a person, not to a workspace: switching
// workspaces in Codex rewrites auth.json with another workspace of the same
// person, and that replaces the person's snapshot instead of adding one, so
// the single-use refresh token never goes stale in a second copy.
function accountFromAuthJson(auth) {
  const tokens = auth?.tokens;
  const workspaceId = tokens?.account_id;
  if (typeof workspaceId !== "string" || workspaceId === "") {
    return null;
  }
  const claims = decodeJwtClaims(tokens.id_token ?? "") ?? {};
  const authClaims = claims["https://api.openai.com/auth"] ?? {};
  const userId = [authClaims.chatgpt_user_id, authClaims.user_id, claims.sub].find(
    (value) => typeof value === "string" && value !== "",
  );
  const accountId = (userId ?? workspaceId).replace(/[^A-Za-z0-9_-]/g, "_");
  const email = typeof claims.email === "string" ? claims.email : null;
  const name =
    typeof claims.name === "string" && claims.name.trim() !== ""
      ? claims.name.trim()
      : null;
  const plan = planName(authClaims.chatgpt_plan_type);
  const display = name ?? email;
  const label =
    display == null ? accountId : plan != null ? `${display} (${plan})` : display;
  return { accountId, workspaceId, label, name: display, email, plan };
}

function readAuthJson() {
  try {
    const parsed = JSON.parse(fs.readFileSync(authFilePath(), "utf8"));
    return typeof parsed === "object" && parsed != null ? parsed : null;
  } catch {
    return null;
  }
}

function activeAccount() {
  return accountFromAuthJson(readAuthJson());
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

// Every snapshot is stored under its person's id. A snapshot found under
// another name, such as one named after a workspace, is moved there; when the
// person already has one, the more recently refreshed login is kept.
function storedAccounts() {
  let entries;
  try {
    entries = fs.readdirSync(accountsDir()).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const snapshots = [];
  for (const name of entries) {
    const file = path.join(accountsDir(), name);
    try {
      const auth = JSON.parse(fs.readFileSync(file, "utf8"));
      const account = accountFromAuthJson(auth);
      if (account != null) {
        snapshots.push({ file, account, refreshedAt: Date.parse(auth.last_refresh ?? "") || 0 });
      }
    } catch {
      continue;
    }
  }
  const byPerson = new Map();
  for (const snapshot of snapshots.sort((left, right) => right.refreshedAt - left.refreshedAt)) {
    const canonical = accountSnapshotPath(snapshot.account.accountId);
    if (byPerson.has(snapshot.account.accountId)) {
      if (snapshot.file !== canonical) {
        fs.rmSync(snapshot.file, { force: true });
      }
      continue;
    }
    if (snapshot.file !== canonical) {
      fs.renameSync(snapshot.file, canonical);
    }
    byPerson.set(snapshot.account.accountId, snapshot.account);
  }
  return [...byPerson.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function removeAccountSnapshot(accountId) {
  fs.rmSync(accountSnapshotPath(accountId), { force: true });
}

// The Office bridge refreshes saved logins from another process while the
// switcher copies them into auth.json. Refresh tokens are single-use, so both
// hold this lock from reading a login until its copy is written. A holder
// that died is detected by the lock's age, which outlasts any refresh.
const ACCOUNT_LOCK_STALE_MS = 30000;
const ACCOUNT_LOCK_WAIT_MS = 20000;

function accountLockPath() {
  return path.join(accountsDir(), ".lock");
}

/** The release function of the account lock, or null while someone else holds it. */
function tryAcquireAccountLock() {
  const lockPath = accountLockPath();
  fs.mkdirSync(accountsDir(), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > ACCOUNT_LOCK_STALE_MS) {
        fs.rmSync(lockPath, { force: true });
      }
    } catch {
      // Released in the meantime; the next attempt takes it.
    }
    return null;
  }
  return () => fs.rmSync(lockPath, { force: true });
}

function withAccountLock(action) {
  const deadline = Date.now() + ACCOUNT_LOCK_WAIT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let release = tryAcquireAccountLock();
  while (release == null) {
    if (Date.now() > deadline) {
      throw new Error("another process is refreshing a saved login; try again in a moment.");
    }
    Atomics.wait(pause, 0, 0, 100);
    release = tryAcquireAccountLock();
  }
  try {
    return action();
  } finally {
    release();
  }
}

function writeAccount(accountId) {
  return withAccountLock(() => {
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
  });
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
  writeConfig(configPath, updated);
  return true;
}

function writeConfig(configPath, updated) {
  const stat = fs.statSync(configPath);
  const backupPath = `${configPath}.bak.before-profile-switcher`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(configPath, backupPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backupPath, stat.mode);
  }
  writeFileAtomic(configPath, updated, stat.mode);
}

// The patcher tags the buttons the mod attaches to. Where a page runs
// bundles without the tags, the label is matched against the translations
// the patcher collected from Codex's locale catalogs, the live intl object,
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
      signIn: {
        kind: "sign-in",
        id: "electron.onboarding.login.chatgpt.continueToSignIn",
        fallback: "Continue to sign in",
      },
      signInOtherAccount: {
        kind: "sign-in-other-account",
        id: "electron.onboarding.login.browserSession.otherAccount",
        fallback: "Use another account",
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

function sidebarProfileScript(provider, providers, account, accounts, anchorLabels, providerIconBody = null) {
  function installSidebarProfileSwitcher(
    initialProvider,
    initialProviders,
    initialAccount,
    initialAccounts,
    iconBody,
  ) {
    const menuId = "codex-profile-switcher-menu";
    const loginPanelId = "codex-login-accounts";
    const loginMenuId = "codex-login-menu";
    const styleId = "codex-profile-switcher-style";
    const openaiProvider = "openai";
    const requestPrefix = "__codex_profile_switch__:";
    const accountRequestPrefix = "__codex_account_switch__:";
    const addAccountRequest = "__codex_account_add__";
    const accountForgetPrefix = "__codex_account_forget__:";
    const activeProviderStorageKey = "__codex_active_provider";
    const anchors = globalThis.__codexModAnchors;
    const menuContentSelector = "[data-radix-menu-content]";
    const sectionAttribute = "data-codex-accounts-section";
    // The rows the mod renders, in its own card and inside Codex's
    // workspace submenu alike.
    const rowScope = `:is(#${menuId}, [${sectionAttribute}])`;
    const accountRowStorageKey = "__codex_profile_account_row";
    const avatarStorageKey = "__codex_profile_avatars";
    const existingController = globalThis.__codexProfileSidebarController;
    if (existingController != null) {
      existingController.setProviderIcon(iconBody);
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
    let providerIconBody = typeof iconBody === "string" ? iconBody : null;
    // Codex's menu header shows the signed-in account as an avatar with the
    // name and plan. That markup is remembered so account rows can reuse it,
    // also on the signed-out screen and under custom profiles, where no such
    // header is rendered.
    let accountRowMarkup = null;
    // The profile pictures Codex showed for each account while it was the
    // signed-in one; accounts without one get Codex's initials avatar.
    let avatarImages = {};
    try {
      accountRowMarkup = localStorage.getItem(accountRowStorageKey);
      avatarImages = JSON.parse(localStorage.getItem(avatarStorageKey) ?? "{}") ?? {};
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
        providerIconBody,
        providerOptions.map((option) => [option.provider, option.label, option.host]),
        accountOptions.map((option) => [option.accountId, option.label]),
      ]);
    }

    function closeMenu() {
      closeLoginMenu();
      const menu = document.getElementById(menuId);
      if (menu != null) {
        menu.hidden = true;
      }
      document
        .querySelector("[data-profile-toggle]")
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

      document.querySelectorAll(`${rowScope} [data-account]`).forEach((option) => {
        // Accounts ride the built-in provider, so their row only highlights
        // while it is active; otherwise the active profile would be marked
        // twice.
        const selected =
          currentProvider === openaiProvider &&
          option.dataset.account === currentAccount;
        option.setAttribute("aria-selected", String(selected));
      });

      document.querySelectorAll(`${rowScope} [data-provider]`).forEach((option) => {
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
        [${sectionAttribute}] {
          display: flex;
          flex-direction: column;
        }
        ${rowScope} button {
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
        ${rowScope} button:hover,
        ${rowScope} button:focus-visible {
          background: var(--color-token-list-hover-background, rgba(127, 127, 127, 0.14));
          outline: none;
        }
        ${rowScope} button[data-account] {
          position: relative;
        }
        /* Menu rows size avatars at 20px inside a 16px icon slot, and the
           base img max-width squeezes a picture into an oval; Codex's own
           header row shows the same picture. */
        [data-leading-icon-slot] > img.rounded-full {
          aspect-ratio: 1;
          max-width: none;
        }
        /* The active entry keeps a persistent filled row with a slightly
           stronger weight; hover uses the lighter list tint. */
        ${rowScope} button[aria-selected="true"] {
          background: color-mix(in oklab, var(--color-token-foreground, #f2f2f2) 12%, transparent);
          font-weight: 500;
        }
        ${rowScope} [data-provider-label],
        ${rowScope} [data-account-label] {
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        /* Overlaid on the row's right edge so revealing it never widens the
           menu; long labels simply run underneath. */
        ${rowScope} [data-row-remove] {
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
        ${rowScope} button[data-account]:hover [data-row-remove],
        ${rowScope} button[data-account]:focus-visible [data-row-remove] {
          display: flex;
        }
        ${rowScope} [data-row-remove]:hover {
          background: color-mix(in oklab, var(--color-token-foreground, #fff) 22%, var(--color-token-dropdown-background, #2f2f2f));
          color: var(--color-token-foreground, inherit);
        }
        ${rowScope} [data-row-remove] svg {
          fill: none;
          height: 12px;
          stroke: currentColor;
          stroke-linecap: round;
          stroke-width: 1.7;
          width: 12px;
        }
        ${rowScope} [data-menu-separator] {
          background: var(--color-token-border, rgba(127, 127, 127, 0.28));
          flex: none;
          height: 1px;
          margin: 4px 6px;
        }
        ${rowScope} [data-menu-heading] {
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
        ${rowScope} button[data-menu-action] {
          border-radius: var(--radius-sm, 6px);
          color: inherit;
          flex: none;
          padding: 1px;
          width: auto;
        }
        ${rowScope} button[data-menu-action]:hover,
        ${rowScope} button[data-menu-action]:focus-visible {
          color: var(--color-token-foreground, inherit);
        }
        ${rowScope} button[data-menu-action] svg {
          display: block;
          fill: none;
          height: 13px;
          stroke: currentColor;
          stroke-linecap: round;
          stroke-width: 1.6;
          width: 13px;
        }
        /* A profile's icon takes the place of an account's picture, drawn
           the way Codex draws its menu icons: in the text color, dimmed
           until the row is hovered or focused. */
        [data-provider-icon] {
          align-items: center;
          display: flex;
          flex: none;
          justify-content: center;
          opacity: 0.75;
        }
        button:is(:hover, :focus-visible) [data-provider-icon],
        [data-profile-toggle]:is(:hover, [aria-expanded="true"]) [data-provider-icon] {
          opacity: 1;
        }
        [data-provider-icon] svg {
          height: 80%;
          width: 80%;
        }
        /* The sign-in screen lists the saved logins as cards in the column
           of sign-in choices, in the colors of Codex's own sign-in buttons. */
        #${loginPanelId} {
          display: flex;
          flex-direction: column;
          user-select: none;
          width: 100%;
        }
        :is(#${loginPanelId}, #${loginMenuId}) [data-login-heading] {
          color: var(--color-codex-description, color-mix(in oklab, currentColor 55%, transparent));
          font-size: 12px;
          line-height: 16px;
          margin: 0 0 6px 4px;
        }
        :is(#${loginPanelId}, #${loginMenuId}) [data-login-group] {
          background: var(--color-surface, transparent);
          border: 1px solid var(--color-border, rgba(127, 127, 127, 0.28));
          border-radius: 12px;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        :is(#${loginPanelId}, #${loginMenuId}) [data-login-group] + [data-login-heading] {
          margin-top: 14px;
        }
        :is(#${loginPanelId}, #${loginMenuId}) [data-login-group] > button {
          align-items: center;
          background: transparent;
          border: 0;
          color: var(--color-text, inherit);
          cursor: var(--cursor-interaction, pointer);
          display: flex;
          font: inherit;
          gap: 12px;
          padding: 10px 14px;
          position: relative;
          text-align: left;
          width: 100%;
        }
        :is(#${loginPanelId}, #${loginMenuId}) [data-login-group] > button + button {
          border-top: 1px solid var(--color-border, rgba(127, 127, 127, 0.28));
        }
        :is(#${loginPanelId}, #${loginMenuId}) [data-login-group] > button:hover,
        :is(#${loginPanelId}, #${loginMenuId}) [data-login-group] > button:focus-visible {
          background: var(--color-background-secondary-ghost-hover, rgba(127, 127, 127, 0.12));
          outline: none;
        }
        :is(#${loginPanelId}, #${loginMenuId}) [data-login-picture] {
          aspect-ratio: 1;
          border-radius: 999px;
          flex: none;
          height: 32px;
          max-width: none;
          object-fit: cover;
          width: 32px;
        }
        :is(#${loginPanelId}, #${loginMenuId}) [data-login-text] {
          display: flex;
          flex: 1 1 auto;
          flex-direction: column;
          min-width: 0;
        }
        :is(#${loginPanelId}, #${loginMenuId}) [data-login-name],
        :is(#${loginPanelId}, #${loginMenuId}) [data-login-subtitle] {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        :is(#${loginPanelId}, #${loginMenuId}) [data-login-name] {
          font-size: 14px;
          font-weight: 500;
          line-height: 20px;
        }
        :is(#${loginPanelId}, #${loginMenuId}) [data-login-subtitle] {
          color: var(--color-codex-description, color-mix(in oklab, currentColor 55%, transparent));
          font-size: 13px;
          line-height: 18px;
        }
        :is(#${loginPanelId}, #${loginMenuId}) [data-row-remove] {
          align-items: center;
          border-radius: 6px;
          color: var(--color-codex-description, color-mix(in oklab, currentColor 55%, transparent));
          display: none;
          flex: none;
          height: 22px;
          justify-content: center;
          width: 22px;
        }
        :is(#${loginPanelId}, #${loginMenuId}) button:hover [data-row-remove],
        :is(#${loginPanelId}, #${loginMenuId}) button:focus-visible [data-row-remove] {
          display: flex;
        }
        :is(#${loginPanelId}, #${loginMenuId}) [data-row-remove]:hover {
          background: color-mix(in oklab, var(--color-text, currentColor) 10%, transparent);
          color: var(--color-text, inherit);
        }
        :is(#${loginPanelId}, #${loginMenuId}) [data-row-remove] svg {
          fill: none;
          height: 14px;
          stroke: currentColor;
          stroke-linecap: round;
          stroke-width: 1.7;
          width: 14px;
        }
        #${loginPanelId}[data-mode="compact"] [data-login-list],
        #${loginPanelId}:not([data-mode="compact"]) [data-login-compact] {
          display: none;
        }
        /* The button that stands in for the list takes the shape of the
           column's own sign-in buttons. */
        #${loginPanelId} [data-login-compact] {
          align-items: center;
          background: transparent;
          border: 1px solid var(--color-border, rgba(127, 127, 127, 0.28));
          border-radius: 999px;
          color: var(--color-text, inherit);
          cursor: var(--cursor-interaction, pointer);
          display: flex;
          font: inherit;
          font-size: 14px;
          font-weight: 500;
          gap: 10px;
          justify-content: center;
          min-height: var(--codex-login-button-height, 44px);
          padding: 0 16px;
          width: 100%;
        }
        #${loginPanelId} [data-login-compact]:hover,
        #${loginPanelId} [data-login-compact]:focus-visible,
        #${loginPanelId} [data-login-compact][aria-expanded="true"] {
          background: var(--color-background-secondary-ghost-hover, rgba(127, 127, 127, 0.12));
          outline: none;
        }
        #${loginPanelId} [data-login-compact-pictures] {
          display: flex;
          flex: none;
        }
        #${loginPanelId} [data-login-compact-pictures] > * {
          aspect-ratio: 1;
          background: var(--color-surface, #fff);
          border-radius: 999px;
          box-shadow: 0 0 0 2px var(--color-surface, #fff);
          height: 20px;
          max-width: none;
          object-fit: cover;
          width: 20px;
        }
        #${loginPanelId} [data-login-compact-pictures] > * + * {
          margin-left: -5px;
        }
        #${loginPanelId} [data-login-compact-chevron] {
          fill: none;
          flex: none;
          height: 14px;
          opacity: 0.6;
          stroke: currentColor;
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-width: 1.6;
          transition: transform 150ms ease;
          width: 14px;
        }
        #${loginPanelId} [data-login-compact][aria-expanded="true"] [data-login-compact-chevron] {
          transform: rotate(180deg);
        }
        /* The saved logins as a menu below that button, drawn like Codex's
           menus and the switcher card. */
        #${loginMenuId} {
          backdrop-filter: blur(var(--blur-sm, 8px));
          background: color-mix(in oklab, var(--color-token-dropdown-background, #2f2f2f) 90%, transparent);
          border-radius: 16px;
          box-shadow: 0 0 0 0.5px var(--color-token-border, rgba(127, 127, 127, 0.28)),
            var(--shadow-xl, 0px 8px 16px -4px rgba(0, 0, 0, 0.12));
          color: var(--color-token-foreground, #f2f2f2);
          display: flex;
          flex-direction: column;
          overflow-y: auto;
          padding: 6px;
          position: fixed;
          user-select: none;
          z-index: 2147483647;
          zoom: var(--codex-window-zoom, 1);
        }
        #${loginMenuId} [data-login-heading] {
          margin: 4px 0 4px 10px;
        }
        #${loginMenuId} [data-login-group] {
          background: transparent;
          border: 0;
          border-radius: 0;
          flex: none;
        }
        #${loginMenuId} [data-login-group] + [data-login-heading] {
          margin-top: 8px;
        }
        #${loginMenuId} [data-login-group] > button {
          border-radius: 10px;
          padding: 8px 10px;
        }
        #${loginMenuId} [data-login-group] > button + button {
          border-top: 0;
        }
        #${loginPanelId} [data-login-divider] {
          align-items: center;
          color: var(--color-codex-description, color-mix(in oklab, currentColor 55%, transparent));
          display: flex;
          font-size: 12px;
          font-weight: 500;
          gap: 16px;
          margin-top: var(--codex-login-column-gap, 12px);
          padding: 8px 0;
        }
        #${loginPanelId} [data-login-divider]::before,
        #${loginPanelId} [data-login-divider]::after {
          background: var(--color-border, rgba(127, 127, 127, 0.28));
          content: "";
          flex: 1;
          height: 1px;
        }
        [data-codex-mod-replaced] {
          display: none !important;
        }
      `;
      document.head.append(style);
    }

    // A login without a remembered picture gets ChatGPT's default avatar,
    // which the avatar service draws from the initials in the file name.
    function avatarFor(details, name) {
      const words = name.trim().split(/\s+/).filter((word) => word !== "");
      const initials = `${words[0]?.charAt(0) ?? ""}${words.length > 1 ? words.at(-1).charAt(0) : ""}`.toLowerCase();
      const remembered = avatarImages[details.accountId];
      const image = document.createElement("img");
      image.alt = "";
      image.className = "shrink-0 object-cover rounded-full size-5";
      image.draggable = false;
      image.referrerPolicy = "no-referrer";
      image.src = typeof remembered === "string"
        ? remembered
        : `https://cdn.auth0.com/avatars/${encodeURIComponent(initials || "na")}.png`;
      return image;
    }

    // Codex's own provider icon from the installed build; a drawn cube
    // stands in where the build has none.
    function providerIcon(className) {
      const icon = document.createElement("span");
      icon.dataset.providerIcon = "";
      icon.className = className;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 16 16");
      svg.setAttribute("aria-hidden", "true");
      if (providerIconBody != null) {
        svg.innerHTML = providerIconBody;
      } else {
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        svg.setAttribute("stroke-width", "1.4");
        for (const pathData of ["M8 2.5 13 5.25v5.5L8 13.5 3 10.75v-5.5L8 2.5Z", "M3 5.25 8 8l5-2.75M8 8v5.5"]) {
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("d", pathData);
          svg.append(path);
        }
      }
      icon.append(svg);
      return icon;
    }

    // Rows reuse the markup of Codex's own account header: a picture, the
    // name, and the plan or a profile's host below it.
    function rowContent(picture, name, subtitle, text) {
      const template = document.createElement("template");
      template.innerHTML = accountRowMarkup;
      const content = template.content.firstElementChild;
      const lines = content?.querySelectorAll(".truncate") ?? [];
      const slot = content?.querySelector("[data-leading-icon-slot]");
      if (content == null || lines.length < 2 || slot == null) {
        return null;
      }
      slot.replaceChildren(picture);
      text.setAttribute("class", lines[0].getAttribute("class"));
      text.textContent = name;
      lines[0].replaceWith(text);
      if (subtitle != null) {
        lines[1].textContent = subtitle;
      } else {
        lines[1].remove();
      }
      return content;
    }

    // Logins of one person in several organizations carry the same name, so
    // their rows add the email to the plan.
    function accountDetails({ accountId, name, plan, email }) {
      const shared = accountOptions.filter((option) => option.name === name).length > 1;
      const subtitle = shared && email != null ? [plan, email].filter(Boolean).join(" · ") : plan;
      return { accountId, name, plan: subtitle };
    }

    function providerDetails({ host }) {
      return { subtitle: host ?? "Custom provider" };
    }

    function rowPicture(kind, details, name, className) {
      return kind === "account" ? avatarFor(details, name) : providerIcon(className);
    }

    function forgetButton(value, label) {
      const forget = document.createElement("span");
      forget.dataset.rowRemove = "";
      forget.setAttribute("role", "button");
      forget.setAttribute("aria-label", `Forget ${label}`);
      const forgetIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      forgetIcon.setAttribute("viewBox", "0 0 16 16");
      forgetIcon.setAttribute("aria-hidden", "true");
      for (const pathData of ["m4.75 4.75 6.5 6.5", "m11.25 4.75-6.5 6.5"]) {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", pathData);
        forgetIcon.append(path);
      }
      forget.append(forgetIcon);
      forget.addEventListener("click", (event) => {
        event.stopPropagation();
        closeMenus();
        console.info(`${accountForgetPrefix}${value}`);
      });
      return forget;
    }

    function menuOption(kind, value, label, onSelect, details = {}) {
      const option = document.createElement("button");
      option.type = "button";
      option.dataset[kind] = value;
      option.setAttribute("role", "option");
      const text = document.createElement("span");
      text.dataset[`${kind}Label`] = "";
      text.textContent = label;
      const name = details.name ?? label;
      const row =
        accountRowMarkup == null
          ? null
          : rowContent(
              rowPicture(kind, details, name, "shrink-0 size-5"),
              name,
              kind === "account" ? details.plan : details.subtitle,
              text,
            );
      option.append(row ?? text);
      if (kind === "account") {
        option.append(forgetButton(value, label));
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

    // The signed-out screen has no sidebar, so the saved accounts and
    // profiles lead its column of sign-in choices. Which buttons the column
    // shows depends on the browser sessions Codex finds, but each of them
    // sits in the same button stack.
    function findLoginAnchor() {
      if (findProfileButton() != null) {
        return null;
      }
      for (const name of ["signIn", "signInOtherAccount", "signInAlternative"]) {
        const anchor = anchors
          .findAll(name)
          .find((button) => button.closest(`#${loginPanelId}`) == null && button.getClientRects().length > 0);
        if (anchor != null) {
          return anchor;
        }
      }
      return null;
    }

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

    function loginRow(kind, value, label, onSelect, details) {
      const row = document.createElement("button");
      row.type = "button";
      row.dataset[kind] = value;
      const name = details.name ?? label;
      const picture = rowPicture(kind, details, name, "");
      picture.dataset.loginPicture = "";
      const text = document.createElement("span");
      text.dataset.loginText = "";
      const title = document.createElement("span");
      title.dataset.loginName = "";
      title.textContent = name;
      text.append(title);
      const subtitle = kind === "account" ? details.plan : details.subtitle;
      if (subtitle != null) {
        const line = document.createElement("span");
        line.dataset.loginSubtitle = "";
        line.textContent = subtitle;
        text.append(line);
      }
      row.append(picture, text);
      if (kind === "account") {
        row.append(forgetButton(value, label));
      }
      row.addEventListener("click", (event) => {
        event.stopPropagation();
        onSelect(value);
      });
      return row;
    }

    function loginSignature() {
      return JSON.stringify([menuSignature(), avatarImages]);
    }

    // The saved logins under their headings, as the list and the menu show them.
    function loginEntries() {
      const entries = [];
      const group = (heading, rows) => {
        const title = document.createElement("div");
        title.dataset.loginHeading = "";
        title.textContent = heading;
        const list = document.createElement("div");
        list.dataset.loginGroup = "";
        list.setAttribute("role", "group");
        list.setAttribute("aria-label", heading);
        list.append(...rows);
        entries.push(title, list);
      };
      if (accountOptions.length > 0) {
        group(
          "Accounts",
          accountOptions.map((option) =>
            loginRow("account", option.accountId, option.label, selectAccount, accountDetails(option)),
          ),
        );
      }
      const profiles = providerOptions.filter((option) => option.provider !== openaiProvider);
      if (profiles.length > 0) {
        group(
          "Profiles",
          profiles.map((option) =>
            loginRow("provider", option.provider, option.label, selectProvider, providerDetails(option)),
          ),
        );
      }
      return entries;
    }

    // Stands in for the list where it does not fit: the first pictures, one
    // label, and the list as a menu.
    function compactLoginButton() {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.loginCompact = "";
      button.setAttribute("aria-haspopup", "listbox");
      button.setAttribute("aria-expanded", "false");
      const pictures = document.createElement("span");
      pictures.dataset.loginCompactPictures = "";
      const profiles = providerOptions.filter((option) => option.provider !== openaiProvider);
      const shown = [
        ...accountOptions.map((option) => rowPicture("account", accountDetails(option), option.name ?? option.label, "")),
        ...profiles.map((option) => rowPicture("provider", providerDetails(option), option.label, "")),
      ].slice(0, 3);
      pictures.append(...shown);
      const label = document.createElement("span");
      label.textContent = "Continue with a saved login";
      const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      chevron.setAttribute("viewBox", "0 0 16 16");
      chevron.setAttribute("aria-hidden", "true");
      chevron.dataset.loginCompactChevron = "";
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "m4.5 6.25 3.5 3.5 3.5-3.5");
      chevron.append(path);
      button.append(pictures, label, chevron);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleLoginMenu(button);
      });
      return button;
    }

    function populateLoginPanel(panel) {
      closeLoginMenu();
      const list = document.createElement("div");
      list.dataset.loginList = "";
      list.append(...loginEntries());
      const divider = document.createElement("div");
      divider.dataset.loginDivider = "";
      divider.setAttribute("aria-hidden", "true");
      const message = globalThis.__codexIntl?.messages?.["electron.onboarding.login.browserSession.or"];
      divider.textContent = typeof message === "string" && message !== "" ? message : "OR";
      panel.dataset.signature = loginSignature();
      panel.replaceChildren(list, compactLoginButton(), divider);
      delete panel.dataset.fitKey;
    }

    // The menu opens below the button, or above it where the window has more
    // room there, and scrolls within the window when it is taller.
    function toggleLoginMenu(button) {
      if (document.getElementById(loginMenuId) != null) {
        closeLoginMenu();
        return;
      }
      ensureStyle();
      const menu = document.createElement("div");
      menu.id = loginMenuId;
      menu.setAttribute("role", "listbox");
      menu.setAttribute("aria-label", "Saved logins");
      menu.append(...loginEntries());
      document.body.append(menu);
      const zoom = menuZoom(menu);
      const rect = button.getBoundingClientRect();
      const margin = 8;
      const below = window.innerHeight - rect.bottom - margin * 2;
      const above = rect.top - margin * 2;
      const room = Math.max(below, above);
      menu.style.left = `${rect.left / zoom}px`;
      menu.style.width = `${rect.width / zoom}px`;
      menu.style.maxHeight = `${room / zoom}px`;
      const height = Math.min(menu.getBoundingClientRect().height, room);
      const top = below >= height || below >= above ? rect.bottom + margin : rect.top - margin - height;
      menu.style.top = `${top / zoom}px`;
      button.setAttribute("aria-expanded", "true");
    }

    function closeLoginMenu() {
      document.getElementById(loginMenuId)?.remove();
      document.querySelector("[data-login-compact]")?.setAttribute("aria-expanded", "false");
    }

    function scrollContainer(element) {
      for (let node = element.parentElement; node != null; node = node.parentElement) {
        if (/^(auto|scroll)$/.test(getComputedStyle(node).overflowY)) {
          return node;
        }
      }
      return document.scrollingElement ?? document.documentElement;
    }

    // The list shows while the whole sign-in screen fits the window, so the
    // screen never opens cut off; otherwise the button takes its place. The
    // list is tried again once the window or the screen changes, within the
    // same frame, so the switch is never painted.
    function fitLoginPanel(panel, stack, firstChoice) {
      const choice = firstChoice.matches("button") ? firstChoice : firstChoice.querySelector("button");
      const height = choice == null ? "" : `${choice.getBoundingClientRect().height / menuZoom(panel)}px`;
      if (height !== "" && panel.style.getPropertyValue("--codex-login-button-height") !== height) {
        panel.style.setProperty("--codex-login-button-height", height);
      }
      const scroller = scrollContainer(stack);
      const overflows = () => scroller.scrollHeight > scroller.clientHeight + 1;
      const key = [scroller.clientHeight, scroller.clientWidth, panel.dataset.signature, stack.childElementCount].join(":");
      if (panel.dataset.mode !== "compact") {
        if (overflows()) {
          panel.dataset.mode = "compact";
        }
      } else if (panel.dataset.fitKey !== key) {
        panel.dataset.mode = "list";
        if (overflows()) {
          panel.dataset.mode = "compact";
        }
      }
      if (panel.dataset.mode !== "compact") {
        closeLoginMenu();
      }
      panel.dataset.fitKey = key;
    }

    // Codex offers the ChatGPT logins it finds in the browser as cards ahead
    // of "Use another account", split from it by a divider. Those cards
    // would list the saved accounts a second time, as a browser sign-in, so
    // the saved logins take their place.
    function replaceBrowserSessions(stack) {
      const otherAccount = anchors
        .findAll("signInOtherAccount", stack)
        .find((button) => button.parentElement === stack);
      for (let node = otherAccount?.previousElementSibling; node != null; node = node.previousElementSibling) {
        if (node.id === loginPanelId) {
          break;
        }
        if (!node.hasAttribute("data-codex-mod-replaced")) {
          node.setAttribute("data-codex-mod-replaced", "");
        }
      }
    }

    function restoreBrowserSessions() {
      document.querySelectorAll("[data-codex-mod-replaced]").forEach((node) => {
        node.removeAttribute("data-codex-mod-replaced");
      });
    }

    function ensureLoginPanel() {
      const anchor = findLoginAnchor();
      const existing = document.getElementById(loginPanelId);
      const hasEntries =
        accountOptions.length > 0 ||
        providerOptions.some((option) => option.provider !== openaiProvider);
      const stack = anchor?.parentElement ?? null;
      if (stack == null || !hasEntries) {
        existing?.remove();
        closeLoginMenu();
        restoreBrowserSessions();
        return;
      }
      ensureStyle();
      let panel = existing;
      if (panel == null) {
        panel = document.createElement("div");
        panel.id = loginPanelId;
        panel.setAttribute("role", "group");
        panel.setAttribute("aria-label", "Saved accounts");
        panel.dataset.mode = "list";
      }
      // The saved logins lead the sign-in choices, below the logo and
      // heading where the column holds those too.
      const firstChoice = [...stack.children].find(
        (child) => child !== panel && (child.matches("button, a, form") || child.querySelector("button, a, input") != null),
      );
      if (firstChoice != null && panel.nextElementSibling !== firstChoice) {
        stack.insertBefore(panel, firstChoice);
      }
      // The divider closing the panel keeps the column's gap on both sides.
      const columnGap = getComputedStyle(stack).rowGap;
      if (panel.style.getPropertyValue("--codex-login-column-gap") !== columnGap) {
        panel.style.setProperty("--codex-login-column-gap", columnGap);
      }
      if (panel.dataset.signature !== loginSignature()) {
        populateLoginPanel(panel);
      }
      replaceBrowserSessions(stack);
      if (firstChoice != null) {
        fitLoginPanel(panel, stack, firstChoice);
      }
    }

    function populateMenu(menu) {
      const entries = [
        menuHeading("Accounts", { label: "Add account", onSelect: requestAddAccount }),
      ];
      if (accountOptions.length > 0) {
        for (const option of accountOptions) {
          entries.push(
            menuOption("account", option.accountId, option.label, selectAccount, accountDetails(option)),
          );
        }
      }
      const profiles = providerOptions.filter(
        (option) => option.provider !== openaiProvider,
      );
      if (profiles.length > 0) {
        const separator = document.createElement("div");
        separator.dataset.menuSeparator = "";
        entries.push(separator, menuHeading("Profiles"));
        for (const option of profiles) {
          entries.push(
            menuOption("provider", option.provider, option.label, selectProvider, providerDetails(option)),
          );
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

    function rememberAccountRow(header) {
      const headerRow = header.querySelector("[data-menu-row-content]");
      const picture = headerRow?.querySelector("[data-leading-icon-slot] img")?.getAttribute("src");
      if (currentProvider === openaiProvider && currentAccount != null) {
        const known = avatarImages[currentAccount] ?? null;
        if ((picture ?? null) !== known) {
          if (picture == null) {
            delete avatarImages[currentAccount];
          } else {
            avatarImages[currentAccount] = picture;
          }
          try {
            localStorage.setItem(avatarStorageKey, JSON.stringify(avatarImages));
          } catch {
            // The pictures stay known for this page only.
          }
          document.getElementById(menuId)?.removeAttribute("data-signature");
        }
      }
      if (
        headerRow?.querySelector("[data-leading-icon-slot]") != null &&
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
    }

    // The saved accounts other than the signed-in person, whose workspaces
    // Codex lists itself, and the custom profiles.
    function populateSection(section) {
      const separator = document.createElement("div");
      separator.dataset.menuSeparator = "";
      const entries = [
        separator,
        menuHeading("Accounts", { label: "Add account", onSelect: requestAddAccount }),
      ];
      for (const option of accountOptions) {
        if (currentProvider === openaiProvider && option.accountId === currentAccount) {
          continue;
        }
        entries.push(
          menuOption("account", option.accountId, option.label, selectAccount, accountDetails(option)),
        );
      }
      const profiles = providerOptions.filter((option) => option.provider !== openaiProvider);
      if (profiles.length > 0) {
        const profileSeparator = document.createElement("div");
        profileSeparator.dataset.menuSeparator = "";
        entries.push(profileSeparator, menuHeading("Profiles"));
        for (const option of profiles) {
          entries.push(
            menuOption("provider", option.provider, option.label, selectProvider, providerDetails(option)),
          );
        }
      }
      section.replaceChildren(...entries);
    }

    // With more than one workspace, Codex's header row opens its own submenu
    // listing them; the accounts and profiles join that submenu below the
    // workspaces instead of competing with it.
    function ensureWorkspaceSubmenu(header) {
      if (header.id === "") {
        return;
      }
      const submenu = document.querySelector(
        `${menuContentSelector}[aria-labelledby="${CSS.escape(header.id)}"]`,
      );
      if (submenu == null || submenu.querySelector(`[${sectionAttribute}]`) != null) {
        return;
      }
      ensureStyle();
      const section = document.createElement("div");
      section.setAttribute(sectionAttribute, "");
      section.setAttribute("role", "group");
      section.setAttribute("aria-label", "Codex accounts");
      // Codex's menu treats a pointerdown outside its items as a dismissal.
      section.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      populateSection(section);
      submenu.append(section);
      renderProvider();
    }

    // Under a custom profile Codex's header row shows just the profile's
    // name; it takes the shape of the profile's row in the switcher instead,
    // with the icon and the host below the name. Codex's own row stays in
    // place, hidden, for React to keep updating.
    function showProfileInHeader(header) {
      const native = header.querySelector(":scope > [data-menu-row-content]");
      const option = providerOptions.find((candidate) => candidate.provider === currentProvider);
      if (
        currentProvider === openaiProvider ||
        option == null ||
        native == null ||
        native.querySelector("[data-leading-icon-slot]") != null ||
        accountRowMarkup == null
      ) {
        return;
      }
      const row = rowContent(
        providerIcon("shrink-0 size-5"),
        providerLabel(currentProvider),
        providerDetails(option).subtitle,
        document.createElement("span"),
      );
      if (row == null) {
        return;
      }
      row.dataset.profileHeaderRow = "";
      native.style.display = "none";
      native.after(row);
    }

    // Codex renders its profile menu afresh on every open. A header row that
    // opens Codex's workspace submenu is left to it; a disabled one, as with a
    // single workspace, becomes the switcher's trigger.
    function ensureProfileMenu() {
      const menu = findProfileMenu();
      if (menu == null) {
        return;
      }
      const header = menu.querySelector('[role="menuitem"]');
      if (header == null) {
        return;
      }
      if (header.getAttribute("aria-haspopup") === "menu" && header.dataset.profileToggle == null) {
        rememberAccountRow(header);
        ensureWorkspaceSubmenu(header);
        return;
      }
      if (header.dataset.profileToggle != null) {
        return;
      }
      ensureStyle();
      rememberAccountRow(header);
      showProfileInHeader(header);
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
      getProvider() {
        return currentProvider;
      },
      providerLabel,
      setProvider(provider) {
        if (providerOptions.some((option) => option.provider === provider)) {
          currentProvider = provider;
          persistProvider();
          renderProvider();
        }
      },
      setProviderIcon(body) {
        providerIconBody = typeof body === "string" ? body : null;
        renderProvider();
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
    globalThis.__codexShowsSignIn = () => findLoginAnchor() != null;

    document.addEventListener(
      "pointerdown",
      (event) => {
        const target = event.target instanceof Node ? event.target : null;
        if (
          target != null &&
          (document.getElementById(loginPanelId)?.contains(target) === true ||
            document.getElementById(loginMenuId)?.contains(target) === true ||
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
    window.addEventListener("resize", () => {
      closeMenu();
      ensureLoginPanel();
    });
    // The login menu is placed for where the button was.
    document.addEventListener(
      "scroll",
      (event) => {
        if (!(event.target instanceof Node && document.getElementById(loginMenuId)?.contains(event.target))) {
          closeLoginMenu();
        }
      },
      true,
    );
    // The menu is portaled into the body, so its arrival shows up as an
    // added subtree there; the card closes along with the menu.
    new MutationObserver((records) => {
      // Codex renders the browser sessions on the sign-in screen once its
      // lookup answers; replacing them in the same task keeps them from
      // ever being painted. Untagged pages rely on the periodic check.
      if (document.querySelector(`[data-codex-mod-anchor^="sign-in"], #${loginPanelId}`) != null) {
        ensureLoginPanel();
      }
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

  return `${anchorScript(anchorLabels)};(${installSidebarProfileSwitcher.toString()})(${JSON.stringify(provider)},${JSON.stringify(providers)},${JSON.stringify(account ?? null)},${JSON.stringify(accounts ?? [])},${JSON.stringify(providerIconBody)})`;
}

// Usage status: a box at the bottom of the sidebar while the sidebar is open,
// and a row under the thread's composer while it is collapsed.
function usageStatusScript(payload, anchorLabels) {
  function installUsageStatus(initialPayload) {
    const boxId = "codex-budget-status";
    const styleId = "codex-budget-status-style";
    const rowAttribute = "data-codex-usage-row";
    const runningSurfaceAttribute = "data-codex-usage-running-surface";
    const runningRowHeight = 22;
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
        #${boxId}[data-placement="panel"] {
          border-bottom: none;
          border-top: 1px solid var(--color-token-border, rgba(127, 127, 127, 0.28));
          padding: 8px 12px 10px;
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
          /* As tall as the reading beside the bar, even without one. */
          min-height: 1lh;
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
        /* The sweep starts and ends on the same color, so one tile of twice
           the track's width scrolls through without a seam. */
        #${boxId} [data-budget-fill][data-unlimited] {
          animation: codex-budget-sweep 12s linear infinite;
        }
        @keyframes codex-budget-sweep {
          from { background-position: 0 0; }
          to { background-position: -200% 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          #${boxId} [data-budget-fill][data-unlimited] {
            animation: none;
          }
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
        :root[data-theme="dark"] #${boxId} [data-budget-resets] {
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
        [${rowAttribute}] {
          align-items: center;
          color: var(--color-token-foreground, inherit);
          container-type: inline-size;
          display: flex;
          font-size: var(--text-xs, 0.75rem);
          gap: 16px;
          line-height: 1rem;
          padding: 0 14px;
          user-select: none;
        }
        /* The floating composer of the browser panel draws one rounded surface
           around the composer and the row, so the row needs room above that
           surface's curved bottom edge. */
        [${rowAttribute}][data-surface="inline"] {
          padding-bottom: 8px;
        }
        /* While a turn runs, the floating panel swaps its composer for a status
           toolbar pinned to the bottom of a surface whose height the app sets
           inline. The surface grows by the row's height, the toolbar moves up,
           and the row takes the strip underneath. */
        [${runningSurfaceAttribute}] {
          height: calc(var(--codex-usage-row-base-height) + ${runningRowHeight}px) !important;
        }
        [${runningSurfaceAttribute}] [data-floating-chat-surface] .h-toolbar:has([role="status"]) {
          bottom: calc(var(--floating-panel-inset, 6px) + ${runningRowHeight}px);
        }
        [${rowAttribute}][data-surface="running"] {
          bottom: calc(var(--floating-panel-inset, 6px) + 8px);
          height: 16px;
          left: 0;
          /* Lines up with the status text and the toolbar's last button. */
          padding: 0 12px 0 24px;
          position: absolute;
          right: 0;
        }
        [${rowAttribute}][data-stale] [data-usage-segment] {
          opacity: 0.5;
        }
        [${rowAttribute}] [data-usage-segment] {
          align-items: center;
          display: flex;
          flex: 1 1 0;
          gap: 6px;
          min-width: 0;
          white-space: nowrap;
        }
        [${rowAttribute}] [data-usage-label],
        [${rowAttribute}] [data-usage-reset],
        [${rowAttribute}] [data-usage-message] {
          color: color-mix(in oklab, currentColor 62%, transparent);
          flex: none;
        }
        [${rowAttribute}] [data-usage-bar] {
          background: color-mix(in oklab, currentColor 14%, transparent);
          border-radius: 3px;
          flex: 1 1 auto;
          height: 6px;
          min-width: 32px;
          overflow: hidden;
        }
        [${rowAttribute}] [data-usage-fill] {
          border-radius: 3px;
          display: block;
          height: 100%;
          transition: width 0.3s ease;
        }
        [${rowAttribute}] [data-usage-amount] {
          flex: none;
          font-variant-numeric: tabular-nums;
        }
        [${rowAttribute}] [data-usage-resets] {
          background: var(--green-50, #d9f4e4);
          border: 0;
          border-radius: 999px;
          color: var(--green-700, #00692a);
          cursor: var(--cursor-interaction, pointer);
          flex: none;
          font: inherit;
          font-weight: 500;
          padding: 0 7px;
        }
        :root[data-theme="dark"] [${rowAttribute}] [data-usage-resets] {
          background: var(--green-800, #004f1f);
          color: var(--green-50, #d9f4e4);
        }
        [${rowAttribute}] [data-usage-resets]:hover {
          filter: brightness(1.18);
        }
        [${rowAttribute}] [data-usage-resets]:focus-visible {
          outline: 2px solid var(--green-500, #00a240);
          outline-offset: 1px;
        }
        [${rowAttribute}] [data-usage-message] {
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        [${rowAttribute}] [data-usage-error],
        [${rowAttribute}] [data-usage-message][data-error] {
          color: var(--red-500, #d64545);
          flex: none;
        }
        @container (max-width: 380px) {
          [${rowAttribute}] [data-usage-reset] {
            display: none;
          }
        }
      `;
      document.head.append(style);
    }

    // Modal backgrounds remain visible even when aria-hidden or inert disables
    // interaction; only visual visibility and the active page determine placement.
    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
        element.closest('[data-app-shell-active-page="false"]') == null
      );
    }

    // One row per window: the main chat's composer takes it whenever it is on
    // screen; side chats and browser panels only get it while the main chat
    // is out of view.
    //
    // Each target names the element the row follows and the surface it sits on.
    function targetComposers() {
      const surfaces = [...document.querySelectorAll("[data-composer-body]")].map((body) =>
        body.closest("[data-composer-surface-variant]"),
      );
      // ChatGPT marks the composer of its Chat mode, which does not draw on
      // these limits; Work and Codex composers carry no mark.
      const visible = [...new Set(surfaces)].filter(
        (composer) =>
          composer != null && composer.closest("[data-chatgpt-composer]") == null && isVisible(composer),
      );
      const main = visible.filter(
        (composer) => composer.closest('[data-app-shell-focus-area="main"]') != null,
      );
      const composer = main[0] ?? visible[0];
      if (composer != null) {
        return [{ after: composerRowAnchor(composer), surface: composer.dataset.composerSurfaceVariant }];
      }
      const toolbar = [
        ...document.querySelectorAll('[data-floating-chat-surface] .h-toolbar:has([role="status"])'),
      ].find(isVisible);
      return toolbar == null ? [] : [{ after: toolbar, surface: "running" }];
    }

    // ChatGPT's composer stacks one fieldset per mode in a single grid cell.
    // Inside that grid the row would take a gapless track flush against the
    // composer, so it goes after the whole stack, into the composer column
    // whose gap spaces it like Codex's composer. On ChatGPT's home pages the
    // surface wraps that stack together with the utility bar it reserves room
    // for underneath, so the row follows the whole surface, below that bar.
    function composerRowAnchor(composer) {
      if (composer.querySelector(":scope > [data-composer-body]") == null) {
        return composer;
      }
      const parent = composer.parentElement;
      const stack = parent.tagName === "FIELDSET" ? parent.parentElement : null;
      if (stack?.parentElement != null && getComputedStyle(stack).display === "grid") {
        return stack.parentElement;
      }
      return parent;
    }

    // The app owns the surface's inline height, so the grown height comes from
    // the stylesheet, based on the height the app last set.
    function markRunningSurfaces(targets) {
      const running = new Set(
        targets
          .filter((target) => target.surface === "running")
          .map((target) => target.after.closest("[data-floating-chat-surface]")?.parentElement)
          .filter((surface) => surface != null),
      );
      for (const surface of document.querySelectorAll(`[${runningSurfaceAttribute}]`)) {
        if (!running.has(surface)) {
          surface.removeAttribute(runningSurfaceAttribute);
          surface.style.removeProperty("--codex-usage-row-base-height");
        }
      }
      for (const surface of running) {
        surface.style.setProperty("--codex-usage-row-base-height", surface.style.height || "52px");
        surface.setAttribute(runningSurfaceAttribute, "");
      }
    }

    // The profile button is the landmark. Builds with the app rail keep it in
    // the rail instead of a sidebar footer, so the box sits at the bottom of
    // the conversation panel beside the rail. A collapsed sidebar has no
    // mount point.
    function findMountPoint() {
      const anchors = globalThis.__codexModAnchors;
      const landmarks = anchors.findAll("profileMenu");
      for (const button of landmarks) {
        if (button.getClientRects().length === 0) {
          continue;
        }
        const row = button.closest(".h-toolbar");
        if (row?.parentElement != null) {
          return { placement: "footer", parent: row.parentElement, before: row };
        }
        const navigation = button
          .closest("nav")
          ?.nextElementSibling?.querySelector("nav[role=navigation]");
        if (navigation?.parentElement != null && isVisible(navigation)) {
          return {
            placement: "panel",
            parent: navigation.parentElement,
            before: navigation.nextSibling,
          };
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

    function clampPercent(percent) {
      return Math.min(100, Math.max(0, percent));
    }

    // Rounding up to 100% would claim the limit is exhausted while some is left.
    function percentText(percentage) {
      return `${percentage >= 100 ? 100 : Math.min(99, Math.round(percentage))}%`;
    }

    function usageColor(percentage) {
      return percentage >= 90 ? "#d64545" : percentage >= 70 ? "#df8f3d" : "#4d9e6f";
    }

    // Off the usage scale on purpose: the colors of the app's Ultra slider.
    const unlimitedFill = "linear-gradient(90deg, #5e7bf3, #bc8cff 28%, #9084f9 50%, #bc8cff 72%, #5e7bf3)";

    // A window only starts counting down with the first message, so an
    // untouched window would otherwise look like it resets after a full
    // period from now.
    function resetText(row) {
      if (row.resetAt == null) {
        return "";
      }
      return row.percent <= 0 ? "not started" : `resets in ${formatReset(row.resetAt)}`;
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
        globalThis.__codexOpenUsageResets?.(Number(resets.dataset.count) || 0);
      });
      labelGroup.append(amounts, resets);
      const reset = document.createElement("span");
      reset.dataset.budgetReset = "";
      amountRow.append(labelGroup, reset);
      row.append(barRow, amountRow);
      return row;
    }

    function renderRow(element, row) {
      const unlimited = row.kind === "unlimited";
      const notice = unlimited || row.kind === "notice";
      const percentage = clampPercent(row.percent);
      const fill = element.querySelector("[data-budget-fill]");
      fill.style.width = `${percentage}%`;
      fill.style.background = unlimited ? unlimitedFill : usageColor(percentage);
      fill.style.backgroundSize = unlimited ? "200% 100%" : "";
      fill.toggleAttribute("data-unlimited", unlimited);
      const percentElement = element.querySelector("[data-budget-percent]");
      percentElement.hidden = notice;
      percentElement.textContent = notice ? "" : percentText(percentage);
      element.querySelector("[data-budget-amounts]").textContent = row.label;
      const resetsButton = element.querySelector("[data-budget-resets]");
      // Without the renderer bridge the pill would be a dead button, so it only
      // appears once the bridge is in place.
      const openable = typeof globalThis.__codexOpenUsageResets === "function";
      resetsButton.hidden = !(openable && row.resets > 0);
      if (!resetsButton.hidden) {
        const label = row.resets === 1 ? "1 reset" : `${row.resets} resets`;
        resetsButton.textContent = label;
        resetsButton.dataset.count = String(row.resets);
        resetsButton.setAttribute("aria-label", `${label} available. Open usage resets`);
      }
      const resetElement = element.querySelector("[data-budget-reset]");
      resetElement.textContent = resetText(row);
      const amountRow = element.querySelector("[data-budget-amount-row]");
      if (resetElement.textContent !== "" && amountRow.scrollWidth > amountRow.clientWidth) {
        resetElement.textContent = "";
      }
    }

    // A profile without a usage source, or an account without a usage limit,
    // keeps the row's frame: a track across the full width, no reading, and
    // the note where the amounts go. Without a limit the track is filled with
    // the unlimited sweep; without data it stays empty.
    function noticeRow(notice, unlimited) {
      return {
        kind: unlimited ? "unlimited" : "notice",
        percent: unlimited ? 100 : 0,
        label: notice,
        resetAt: null,
      };
    }

    function renderSidebarBox(mount, rows, error, notice, unlimited) {
      if (rows.length === 0 && notice != null && error == null) {
        rows = [noticeRow(notice, unlimited)];
      }
      let box = document.getElementById(boxId);
      const placed =
        box != null &&
        box.parentElement === mount.parent &&
        (mount.before === box || box.nextSibling === mount.before);
      if (!placed) {
        box?.remove();
        box = document.createElement("div");
        box.id = boxId;
        mount.parent.insertBefore(box, mount.before);
      }
      box.dataset.placement = mount.placement;
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

    function span(key) {
      const element = document.createElement("span");
      element.dataset[key] = "";
      return element;
    }

    function createSegment() {
      const segment = document.createElement("div");
      segment.dataset.usageSegment = "";
      const bar = span("usageBar");
      bar.append(span("usageFill"));
      segment.append(span("usageLabel"), bar, span("usageAmount"), span("usageReset"));
      return segment;
    }

    function renderSegment(segment, row) {
      const percentage = clampPercent(row.percent);
      const color = usageColor(percentage);
      const cost = row.kind === "budget";
      const fill = segment.querySelector("[data-usage-fill]");
      fill.style.width = `${percentage}%`;
      fill.style.background = color;
      const label = segment.querySelector("[data-usage-label]");
      label.hidden = cost;
      label.textContent = cost ? "" : row.label;
      const amount = segment.querySelector("[data-usage-amount]");
      amount.textContent = cost ? row.label : percentText(percentage);
      amount.style.color = percentage >= 70 ? color : "";
      const reset = resetText(row);
      segment.querySelector("[data-usage-reset]").textContent = reset.replace("resets in", "resets");
      const used = cost ? `${row.label} used` : `${row.label}: ${percentText(percentage)} used`;
      segment.title = reset === "" ? used : `${used}, ${reset}`;
    }

    function createResetsButton() {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.usageResets = "";
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        globalThis.__codexOpenUsageResets?.(Number(button.dataset.count) || 0);
      });
      return button;
    }

    function capitalize(text) {
      return text.charAt(0).toUpperCase() + text.slice(1);
    }

    // Without rows the row still speaks up when the first fetch failed.
    function renderError(element, error) {
      let message = element.querySelector("[data-usage-message]");
      if (message == null) {
        message = span("usageMessage");
        element.replaceChildren(message);
      }
      message.toggleAttribute("data-error", true);
      message.textContent = "Error fetching usage";
      message.title = capitalize(error);
      element.removeAttribute("data-stale");
    }

    function renderRows(element, rows, error) {
      let segments = [...element.querySelectorAll("[data-usage-segment]")];
      if (segments.length !== rows.length || element.querySelector("[data-usage-message]") != null) {
        segments = rows.map(createSegment);
        element.replaceChildren(...segments);
      }
      rows.forEach((row, index) => renderSegment(segments[index], row));

      const resets = rows.reduce((count, row) => count + (row.resets ?? 0), 0);
      let resetsButton = element.querySelector("[data-usage-resets]");
      // Without the renderer bridge the pill would be a dead button.
      if (resets > 0 && typeof globalThis.__codexOpenUsageResets === "function") {
        resetsButton ??= element.appendChild(createResetsButton());
        const label = resets === 1 ? "1 reset" : `${resets} resets`;
        resetsButton.textContent = label;
        resetsButton.dataset.count = String(resets);
        resetsButton.setAttribute("aria-label", `${label} available. Open usage resets`);
      } else {
        resetsButton?.remove();
      }

      // A failed refresh keeps the last known rows, dimmed.
      element.toggleAttribute("data-stale", error != null);
      let errorElement = element.querySelector("[data-usage-error]");
      if (error == null) {
        errorElement?.remove();
      } else {
        errorElement ??= element.appendChild(span("usageError"));
        errorElement.textContent = "Refresh failed";
        errorElement.title = capitalize(error);
      }
    }

    function renderComposerRows(targets, rows, error) {
      const current = new Set();
      markRunningSurfaces(targets);
      for (const { after, surface } of targets) {
        let element = after.nextElementSibling;
        if (element?.hasAttribute(rowAttribute) !== true) {
          element = document.createElement("div");
          element.setAttribute(rowAttribute, "");
          after.after(element);
        }
        element.dataset.surface = surface;
        if (rows.length > 0) {
          renderRows(element, rows, error);
        } else {
          renderError(element, error);
        }
        current.add(element);
      }
      for (const element of document.querySelectorAll(`[${rowAttribute}]`)) {
        if (!current.has(element)) {
          element.remove();
        }
      }
    }

    function render() {
      const rows = currentPayload?.rows ?? [];
      const error = typeof currentPayload?.error === "string" ? currentPayload.error : null;
      const notice = typeof currentPayload?.notice === "string" ? currentPayload.notice : null;
      const unlimited = currentPayload?.unlimited === true;
      const shown = rows.length > 0 || error != null || notice != null;
      const mount = shown ? findMountPoint() : null;
      if (shown) {
        ensureStyle();
      }
      if (mount == null) {
        document.getElementById(boxId)?.remove();
      } else {
        renderSidebarBox(mount, rows, error, notice, unlimited);
      }
      // Notes only fit the open sidebar; under the composer they would crowd
      // the input for nothing actionable.
      const composerShown = rows.length > 0 || error != null;
      renderComposerRows(composerShown && mount == null ? targetComposers() : [], rows, error);
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
    // The box follows the sidebar into the frame Codex renders it in: while
    // it is missing, every change renders right away, afterwards at most once
    // a frame. Its own changes are not observed, so a render never schedules
    // the next one; the interval catches changes that only touch attributes.
    let scheduled = false;
    const renderUnobserved = () => {
      observer.disconnect();
      try {
        render();
      } finally {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    };
    const observer = new MutationObserver(() => {
      const rows = currentPayload?.rows ?? [];
      const shown = rows.length > 0 || currentPayload?.error != null || currentPayload?.notice != null;
      if (shown && document.getElementById(boxId) == null) {
        renderUnobserved();
        return;
      }
      if (scheduled) {
        return;
      }
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        renderUnobserved();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    render();
    setInterval(render, 1500);
    return true;
  }

  return `${anchorScript(anchorLabels)};(${installUsageStatus.toString()})(${JSON.stringify(payload)})`;
}

// A chat that runs under another profile than the active one shows a notice
// in place of its composer that offers to fork it: a new chat under the
// active profile that carries the history over as plain messages, which no
// provider rejects. The new chat's transcript starts empty; a chip in it
// says that the history is there for the model. Sidebar rows of such chats
// are greyed. The sources of truth are the thread list of Codex's
// app-server, reached through the client the patched bundles expose, and the
// active profile the switcher keeps.
function threadGuardScript() {
  function installThreadGuard() {
    const existingController = globalThis.__codexThreadGuardController;
    if (existingController != null) {
      existingController.ensure();
      return true;
    }
    const noticeAttribute = "data-codex-thread-notice";
    const lockAttribute = "data-codex-thread-locked";
    const foreignAttribute = "data-codex-thread-foreign";
    const sidebarRowSelector = "[data-app-action-sidebar-thread-row]";
    const styleId = "codex-thread-guard-style";
    const forkedStorageKey = "__codex_forked_threads";
    const activeProviderStorageKey = "__codex_active_provider";
    const localHost = "local";
    const itemTextLimit = 1500;
    const historyCharLimit = 400000;
    const buttonBase =
      "no-drag cursor-interaction items-center select-none focus:outline-none " +
      "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 gap-1 " +
      "border whitespace-nowrap flex rounded-lg h-token-button-composer px-3 py-0 " +
      "text-base leading-[18px]";
    const primaryButton =
      `${buttonBase} border-default bg-primary-solid enabled:hover:bg-text/80 text-primary-solid`;
    const secondaryButton =
      `${buttonBase} text-default bg-text/5 enabled:hover:bg-text/10 border-transparent`;
    let forking = null;
    let inputGuardInstalled = false;
    let observer = null;
    // Provider and title per thread id, read from the app-server's own
    // list: the registered manager is not always the one that feeds the
    // sidebar, so its summaries can be empty. Threads the list leaves out,
    // such as a fork without a turn yet, are read one by one; what stays
    // unknown is kept with a null provider and checked again after a while.
    const threadIndex = new Map();
    const unknownRecheckMs = 60000;
    const refreshIntervalMs = 5000;
    const readBatchLimit = 20;
    let refreshing = null;
    let refreshedAt = 0;

    // The composer is hidden, which stops clicks and focus, but the app also
    // routes keys typed anywhere into it, so those are stopped before the
    // app sees them while a lock is on. Shortcuts and the mod's own dialogs
    // keep working.
    function ensureInputGuard() {
      if (inputGuardInstalled) {
        return;
      }
      inputGuardInstalled = true;
      const editableSelector = "input, textarea, select, [contenteditable=true]";
      const interactiveSelector =
        `${editableSelector}, button, a, [role=button], [role=link], [role=menuitem], ` +
        "[role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=tab], [role=checkbox], [role=switch]";
      // Whether an event aimed at `target` would end up in the locked
      // composer: it is inside it, or the focus is on nothing that takes
      // text itself, which is when the app forwards typing to the composer.
      const reachesLock = (target, selector) => {
        const locked = document.querySelector(`[${lockAttribute}]`);
        if (locked == null || document.querySelector(".codex-mod-modal") != null) {
          return false;
        }
        const element = target instanceof Element ? target : document.activeElement;
        if (element != null && locked.contains(element)) {
          return true;
        }
        const owner = element?.closest?.(selector) ?? null;
        return owner == null || locked.contains(owner);
      };
      window.addEventListener(
        "keydown",
        (event) => {
          if (event.metaKey || event.ctrlKey || event.altKey) {
            return;
          }
          const selector =
            event.key.length === 1 || event.key === "Backspace" ? editableSelector : event.key === "Enter" ? interactiveSelector : null;
          if (selector != null && reachesLock(event.target, selector)) {
            event.stopImmediatePropagation();
            event.preventDefault();
          }
        },
        true,
      );
      for (const type of ["paste", "beforeinput", "drop"]) {
        window.addEventListener(
          type,
          (event) => {
            if (reachesLock(event.target, editableSelector)) {
              event.stopImmediatePropagation();
              event.preventDefault();
            }
          },
          true,
        );
      }
    }

    function ensureStyle() {
      if (document.getElementById(styleId) != null) {
        return;
      }
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        [${lockAttribute}] {
          display: none !important;
        }
        [${foreignAttribute}] [data-thread-title-trigger] {
          opacity: 0.45;
        }
        [${noticeAttribute}] {
          align-items: center;
          background: color-mix(in oklab, currentColor 5%, transparent);
          border: 1px solid var(--color-token-border, rgba(127, 127, 127, 0.28));
          border-radius: 12px;
          color: var(--color-token-foreground, inherit);
          display: flex;
          font-size: var(--text-sm, 0.8125rem);
          gap: 12px;
          line-height: var(--text-sm--line-height, 1.25rem);
          margin: 0 0 8px;
          padding: 8px 12px;
          user-select: none;
        }
        [${noticeAttribute}="lock"] {
          margin: 0;
        }
        [${noticeAttribute}] [data-notice-text] {
          flex: 1;
          min-width: 0;
        }
        [${noticeAttribute}] [data-notice-detail] {
          color: color-mix(in oklab, currentColor 62%, transparent);
          font-size: var(--text-xs, 0.75rem);
          line-height: 1rem;
        }
        [${noticeAttribute}] button:disabled {
          opacity: 0.6;
        }
      `;
      document.head.append(style);
    }

    function activeProvider() {
      const controller = globalThis.__codexProfileSidebarController;
      if (typeof controller?.getProvider === "function") {
        return controller.getProvider();
      }
      try {
        return localStorage.getItem(activeProviderStorageKey);
      } catch {
        return null;
      }
    }

    function providerLabel(provider) {
      const controller = globalThis.__codexProfileSidebarController;
      return (
        (typeof controller?.providerLabel === "function" ? controller.providerLabel(provider) : null) ??
        provider
      );
    }

    // The app-server client of the local host, an RPC stub whose calls all
    // return promises.
    function manager() {
      return globalThis.__codexAppServerClient?.(localHost) ?? null;
    }

    function rowThreadId(row) {
      return row.getAttribute("data-app-action-sidebar-thread-id")?.replace(/^local:/, "") ?? null;
    }

    function rowThreadIds() {
      return [...document.querySelectorAll(sidebarRowSelector)].map(rowThreadId).filter((id) => id != null);
    }

    function threadKnown(threadId) {
      const entry = threadIndex.get(threadId);
      return entry != null && (entry.provider != null || Date.now() - entry.checkedAt < unknownRecheckMs);
    }

    async function listThreads(archived, wanted) {
      const current = manager();
      let cursor = null;
      for (let page = 0; page < 5 && current != null; page += 1) {
        const result = await current.sendRequest("thread/list", {
          limit: 100,
          cursor,
          modelProviders: [],
          archived,
          useStateDbOnly: true,
        });
        for (const thread of result.data ?? []) {
          threadIndex.set(thread.id, {
            provider: thread.modelProvider ?? null,
            title: (thread.name || thread.preview || "").trim(),
            checkedAt: Date.now(),
          });
          wanted.delete(thread.id);
        }
        cursor = result.nextCursor ?? null;
        if (cursor == null || wanted.size === 0) {
          return;
        }
      }
    }

    async function readThreads(wanted) {
      const current = manager();
      if (current == null) {
        return;
      }
      await Promise.all(
        [...wanted].slice(0, readBatchLimit).map(async (threadId) => {
          try {
            const { thread } = await current.sendRequest("thread/read", { threadId, includeTurns: false });
            threadIndex.set(threadId, {
              provider: thread?.modelProvider ?? null,
              title: (thread?.name || thread?.preview || "").trim(),
              checkedAt: Date.now(),
            });
            wanted.delete(threadId);
          } catch {
            // Stays unknown until the next check.
          }
        }),
      );
    }

    // Reads the list until every sidebar row is known; `force` reads it
    // again regardless, for fresh titles.
    function refreshThreads(force = false) {
      if (refreshing != null) {
        return refreshing;
      }
      if (!force && Date.now() - refreshedAt < refreshIntervalMs) {
        return Promise.resolve();
      }
      refreshedAt = Date.now();
      const wanted = new Set(rowThreadIds().filter((id) => force || !threadKnown(id)));
      refreshing = (async () => {
        try {
          await listThreads(false, wanted);
          if (wanted.size > 0) {
            await listThreads(true, wanted);
          }
          if (wanted.size > 0) {
            await readThreads(wanted);
          }
        } catch {
          // The next render asks again.
        } finally {
          for (const id of wanted) {
            threadIndex.set(id, { provider: null, title: threadIndex.get(id)?.title ?? "", checkedAt: Date.now() });
          }
          refreshing = null;
          render();
        }
      })();
      return refreshing;
    }

    function threadProvider(threadId) {
      return threadIndex.get(threadId)?.provider ?? null;
    }

    function activeThreadId() {
      return (
        document
          .querySelector('[data-app-action-sidebar-thread-active="true"]')
          ?.getAttribute("data-app-action-sidebar-thread-id")
          ?.replace(/^local:/, "") ?? null
      );
    }

    // A locked composer is hidden, so its parent, which also holds the
    // notice, stands in for it. The app keeps a page per recently opened
    // chat; only the active page counts.
    function isVisible(element) {
      if (element.closest('[aria-hidden=true], [inert], [data-app-shell-active-page="false"]') != null) {
        return false;
      }
      const probe = element.hasAttribute(lockAttribute) ? element.parentElement : element;
      const rect = probe.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        probe.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      );
    }

    function mainComposer() {
      const visible = [
        ...document.querySelectorAll("[data-composer-surface-variant]:has(> [data-composer-body])"),
      ].filter(isVisible);
      return (
        visible.find((composer) => composer.closest('[data-app-shell-focus-area="main"]') != null) ??
        visible[0] ??
        null
      );
    }

    function forkedThreads() {
      try {
        const parsed = JSON.parse(localStorage.getItem(forkedStorageKey) ?? "{}");
        return typeof parsed === "object" && parsed != null ? parsed : {};
      } catch {
        return {};
      }
    }

    function writeForkedThreads(value) {
      try {
        localStorage.setItem(forkedStorageKey, JSON.stringify(value));
      } catch {
        return;
      }
    }

    function clip(text, limit = itemTextLimit) {
      const value = String(text ?? "");
      if (value.length <= limit) {
        return value;
      }
      return `${value.slice(0, limit)}\n[... ${value.length - limit} more characters]`;
    }

    function userText(item) {
      return (item.content ?? [])
        .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
        .join("\n")
        .trim();
    }

    // Tool activity as the model will read it back, one bracketed block per
    // item; null for items that carry nothing worth remembering.
    function toolText(item) {
      switch (item.type) {
        case "commandExecution": {
          const exit = item.exitCode == null ? "" : `, exit ${item.exitCode}`;
          return `[command${exit}] ${item.command}\n${clip(item.aggregatedOutput)}`.trimEnd();
        }
        case "fileChange":
          return (item.changes ?? [])
            .map((change) => `[file ${change.kind?.type ?? "change"}] ${change.path}\n${clip(change.diff)}`.trimEnd())
            .join("\n");
        case "mcpToolCall": {
          const result = (item.result?.content ?? [])
            .map((part) => (typeof part.text === "string" ? part.text : `[${part.type}]`))
            .join("\n");
          const args = clip(JSON.stringify(item.arguments ?? {}), 600);
          return `[tool ${item.server}/${item.tool}] ${args}\n${clip(result)}`.trimEnd();
        }
        case "webSearch": {
          const results = (item.results ?? [])
            .slice(0, 5)
            .map((result) => `- ${[result.title, result.url].filter(Boolean).join(" ")}`);
          return [`[web search] ${item.query ?? ""}`, ...results].join("\n");
        }
        case "plan":
          return `[plan]\n${clip(item.text, 6000)}`;
        case "imageView":
          return `[viewed image] ${item.path ?? ""}`.trim();
        case "contextCompaction":
          return "[context compacted]";
        case "subAgentActivity":
          return `[sub-agent ${item.kind ?? ""}] ${item.agentPath ?? ""}`.trim();
        case "reasoning":
        case "sleep":
          return null;
        default:
          return `[${item.type}]`;
      }
    }

    function turnRecords(turns) {
      return turns.map((turn) => {
        const user = [];
        const parts = [];
        for (const item of turn.items ?? []) {
          if (item.type === "userMessage") {
            user.push(userText(item));
          } else if (item.type === "agentMessage") {
            parts.push({ tool: false, text: String(item.text ?? "").trim() });
          } else {
            const text = toolText(item);
            if (text) {
              parts.push({ tool: true, text });
            }
          }
        }
        if (turn.error != null) {
          const message = typeof turn.error === "string" ? turn.error : turn.error.message;
          parts.push({ tool: true, text: `[turn failed: ${message ?? JSON.stringify(turn.error)}]` });
        }
        return { user: user.filter(Boolean).join("\n\n"), parts: parts.filter((part) => part.text) };
      });
    }

    // Keeps the history under the limit: tool activity goes first, oldest
    // turns first, then whole turns from the start. Returns the omitted count.
    function fitRecords(records) {
      const size = () =>
        records.reduce(
          (total, record) => total + record.user.length + record.parts.reduce((sum, part) => sum + part.text.length, 0),
          0,
        );
      for (const record of records) {
        if (size() <= historyCharLimit) {
          break;
        }
        record.parts = record.parts.filter((part) => !part.tool);
      }
      let omitted = 0;
      while (records.length > 1 && size() > historyCharLimit) {
        records.shift();
        omitted += 1;
      }
      return omitted;
    }

    function message(role, text) {
      const type = role === "assistant" ? "output_text" : "input_text";
      return { type: "message", role, content: [{ type, text }] };
    }

    function historyItems(turns, sourceId) {
      const records = turnRecords(turns);
      const omitted = fitRecords(records);
      const intro = [
        "This chat continues an earlier chat that ran under another model provider.",
        "Its history follows as plain messages; tool activity is summarized inside the",
        "assistant messages in square brackets.",
        omitted > 0 ? `The first ${omitted} turn(s) were omitted for length.` : null,
        `When you need more detail than this history gives, read the earlier chat with the read_thread tool; its thread id is ${sourceId}.`,
        "Continue the conversation from the last message.",
      ]
        .filter(Boolean)
        .join(" ");
      const items = [message("developer", intro)];
      for (const record of records) {
        if (record.user) {
          items.push(message("user", record.user));
        }
        const assistant = record.parts.map((part) => part.text).join("\n\n");
        if (assistant) {
          items.push(message("assistant", assistant));
        }
      }
      return { items, turns: records.length, omitted };
    }

    // Forks are numbered the way Codex names its own: the first free
    // "Title (n)" from 2 up, counting from the source's unnumbered title.
    function forkName(sourceTitle) {
      const base = sourceTitle.replace(/ \(\d+\)$/, "");
      const titles = new Set([
        ...[...threadIndex.values()].map((entry) => entry.title),
        ...[...document.querySelectorAll(sidebarRowSelector)].map(
          (row) => row.getAttribute("data-app-action-sidebar-thread-title")?.trim() ?? "",
        ),
      ]);
      let number = 2;
      while (titles.has(`${base} (${number})`)) {
        number += 1;
      }
      return `${base} (${number})`;
    }

    function sleep(milliseconds) {
      return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }

    // The new thread reaches the sidebar through the app-server's own
    // notification; its entry is clicked once it is there.
    async function openThread(threadId) {
      const selector = `[data-app-action-sidebar-thread-id="local:${threadId}"]`;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const entry = document.querySelector(selector);
        if (entry != null) {
          entry.click();
          return true;
        }
        await sleep(250);
      }
      return false;
    }

    async function fork(threadId) {
      const current = manager();
      const target = activeProvider();
      if (current == null || target == null || forking != null) {
        return;
      }
      const show = globalThis.__codexShowModal;
      forking = threadId;
      render();
      try {
        const { thread } = await current.sendRequest("thread/read", { threadId, includeTurns: true });
        const history = historyItems(thread.turns ?? [], threadId);
        const started = await current.sendRequest("thread/start", {
          cwd: thread.cwd ?? null,
          modelProvider: target,
        });
        const forkedId = started.thread.id;
        await current.sendRequest("thread/inject_items", { threadId: forkedId, items: history.items });
        const title = (thread.name || thread.preview || "").trim().slice(0, 80);
        if (title) {
          await refreshThreads(true);
          await current.sendRequest("thread/name/set", { threadId: forkedId, name: forkName(title) }).catch(() => {});
        }
        const forked = forkedThreads();
        forked[forkedId] = {
          source: threadId,
          title,
          turns: history.turns,
          omitted: history.omitted,
        };
        writeForkedThreads(forked);
        console.info(`__codex_thread_forked__:${JSON.stringify({ source: threadId, forked: forkedId, turns: history.turns })}`);
        if (!(await openThread(forkedId))) {
          show?.({
            message: "The forked chat is ready",
            detail: "It did not show up in the sidebar yet; open it from there.",
            buttons: ["OK"],
          });
        }
      } catch (error) {
        show?.({
          message: "Could not fork the chat",
          detail: String(error?.message ?? error),
          buttons: ["OK"],
        });
      } finally {
        forking = null;
        render();
      }
    }

    function notice(kind, composer) {
      let element = composer.previousElementSibling;
      if (element?.getAttribute(noticeAttribute) !== kind) {
        element?.hasAttribute(noticeAttribute) && element.remove();
        element = document.createElement("div");
        element.setAttribute(noticeAttribute, kind);
        composer.before(element);
      }
      return element;
    }

    function renderLock(composer, threadId, provider) {
      const target = activeProvider();
      const element = notice("lock", composer);
      const busy = forking === threadId;
      const key = `${threadId}:${provider}:${target}:${busy}`;
      if (element.dataset.key === key) {
        return;
      }
      element.dataset.key = key;
      const text = document.createElement("div");
      text.setAttribute("data-notice-text", "");
      const title = document.createElement("div");
      title.textContent = `This chat belongs to ${providerLabel(provider)}.`;
      const detail = document.createElement("div");
      detail.setAttribute("data-notice-detail", "");
      detail.textContent =
        `Messages can only be sent under that profile. ` +
        `Fork it to continue under ${providerLabel(target)}.`;
      text.append(title, detail);
      const button = document.createElement("button");
      button.type = "button";
      button.className = primaryButton;
      button.textContent = busy ? "Forking…" : "Fork";
      button.disabled = busy;
      button.addEventListener("click", () => void fork(threadId));
      element.replaceChildren(text, button);
    }

    function renderChip(composer, threadId, entry) {
      const element = notice("forked", composer);
      if (element.dataset.key === threadId) {
        return;
      }
      element.dataset.key = threadId;
      const text = document.createElement("div");
      text.setAttribute("data-notice-text", "");
      const title = document.createElement("div");
      title.textContent = entry.title ? `Forked from “${entry.title.slice(0, 80)}”.` : "Forked chat.";
      const detail = document.createElement("div");
      detail.setAttribute("data-notice-detail", "");
      const turns = entry.turns === 1 ? "1 turn" : `${entry.turns} turns`;
      detail.textContent = `Message history is invisible (${turns}), but the model can see them.`;
      text.append(title, detail);
      const button = document.createElement("button");
      button.type = "button";
      button.className = secondaryButton;
      button.textContent = "Hide";
      button.addEventListener("click", () => {
        const forked = forkedThreads();
        delete forked[threadId];
        writeForkedThreads(forked);
        render();
      });
      element.replaceChildren(text, button);
    }

    function clearNotices(except) {
      for (const element of document.querySelectorAll(`[${noticeAttribute}]`)) {
        if (element !== except) {
          element.remove();
        }
      }
    }

    function unlockAll(except) {
      for (const element of document.querySelectorAll(`[${lockAttribute}]`)) {
        if (element !== except) {
          element.removeAttribute(lockAttribute);
        }
      }
    }

    function markSidebar() {
      const target = activeProvider();
      let unknown = false;
      for (const row of document.querySelectorAll(sidebarRowSelector)) {
        const threadId = rowThreadId(row);
        const provider = threadId == null ? null : threadProvider(threadId);
        unknown ||= threadId != null && !threadKnown(threadId);
        const foreign = provider != null && target != null && provider !== target;
        if (foreign) {
          ensureStyle();
          row.setAttribute(foreignAttribute, "");
        } else {
          row.removeAttribute(foreignAttribute);
        }
      }
      if (unknown) {
        void refreshThreads();
      }
    }

    // Pages switch and rows come and go as sections expand and the list
    // refreshes; the observer re-renders as soon as that happens instead of
    // on the next tick. Rendering only adds or removes attributes once the
    // notice is in place, so it does not retrigger itself.
    function ensureObserver() {
      if (observer != null) {
        return;
      }
      let scheduled = false;
      observer = new MutationObserver(() => {
        if (scheduled) {
          return;
        }
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          render();
        });
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }

    function render() {
      ensureObserver();
      markSidebar();
      const composer = mainComposer();
      const threadId = activeThreadId();
      const target = activeProvider();
      const provider = threadId == null ? null : threadProvider(threadId);
      const locked = composer != null && provider != null && target != null && provider !== target;
      const forked = threadId == null ? null : (forkedThreads()[threadId] ?? null);
      if (locked) {
        ensureStyle();
        ensureInputGuard();
        composer.setAttribute(lockAttribute, "");
        unlockAll(composer);
        renderLock(composer, threadId, provider);
        clearNotices(composer.previousElementSibling);
        return;
      }
      unlockAll(null);
      if (composer != null && forked != null) {
        ensureStyle();
        renderChip(composer, threadId, forked);
        clearNotices(composer.previousElementSibling);
        return;
      }
      clearNotices(null);
    }

    globalThis.__codexThreadGuardController = { ensure: render };
    render();
    setInterval(render, 1000);
    return true;
  }

  return `(${installThreadGuard.toString()})()`;
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
      } = options ?? {};
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
        let settled = false;
        const finish = (index) => {
          if (settled) {
            return;
          }
          settled = true;
          document.removeEventListener("keydown", onKey, true);
          overlay.remove();
          resolve(index);
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
        actions.append(...elements);
        const parts = [title];
        if (detail !== "") {
          parts.push(body);
        }
        parts.push(actions);
        dialog.append(...parts);
        overlay.append(dialog);
        document.body.append(overlay);
        (elements[cancelId ?? defaultId] ?? elements[0])?.focus();
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

// Whether the page runs the patched bundles and the controls of the given
// build. The injected controls alone do not count, since the host renders
// them into stock pages as well. The build matters because the installers
// keep the controllers of whichever build rendered into the page first.
function modPresentScript(build) {
  return `globalThis.__codexModBundles === true && globalThis.__codexModBuild === ${JSON.stringify(build)}`;
}

function markModBuildScript(build) {
  return `globalThis.__codexModBuild = ${JSON.stringify(build)}; true`;
}

// The thread the main window shows, read from the sidebar's active entry;
// null on the new-chat page and other views.
function activeThreadScript() {
  return `(document.querySelector('[data-app-action-sidebar-thread-active="true"]')
    ?.getAttribute("data-app-action-sidebar-thread-id")
    ?.replace(/^local:/, "") ?? null)`;
}

const MAIN_PAGE_URL = "app://-/index.html";

// Codex opens the route an `initialRoute` query names on startup, the way it
// restores its own windows, so a reload through that URL lands in the thread
// instead of on the new-chat page. Codex keeps its composer drafts per thread.
function threadRouteUrl(threadId) {
  return `${MAIN_PAGE_URL}?initialRoute=${encodeURIComponent(`/local/${threadId}`)}`;
}

// Resolves once a window loaded through threadRouteUrl shows the thread, and
// drops the query again: the main window is the one without an
// `initialRoute`, and Codex's router keeps working on the plain URL.
function settleThreadRouteScript() {
  return `new Promise((resolve) => {
    const deadline = Date.now() + 10000;
    const tick = () => {
      const shown = document.querySelector('[data-app-action-sidebar-thread-active="true"]') != null;
      if (shown || Date.now() > deadline) {
        history.replaceState(history.state, "", ${JSON.stringify(MAIN_PAGE_URL)});
        resolve(shown);
      } else {
        setTimeout(tick, 100);
      }
    };
    tick();
  })`;
}

// Small notices in the window's top right corner, above every pane: a pill
// for the short steps of an update and cards that offer an installed update,
// announce a new release or say that one needs a newer Codex.
function noticesScript() {
  function installNotices() {
    if (globalThis.__codexModNotices != null) {
      return true;
    }
    const style = document.createElement("style");
    style.id = "codex-mod-notice-style";
    style.textContent = `
      .codex-mod-notices { position: fixed; top: 52px; right: 16px; z-index: 2147482000; display: flex;
        flex-direction: column; align-items: flex-end; gap: 8px; pointer-events: none; }
      body:has([data-desktop-login-surface], [data-codex-mod-anchor^="sign-in"], #codex-login-accounts) .codex-mod-notices { top: 16px; }
      .codex-mod-notice { opacity: 0; transform: translateX(12px);
        transition: opacity 180ms ease, transform 240ms cubic-bezier(.2,.8,.2,1); pointer-events: auto; }
      .codex-mod-notice[data-open="true"] { opacity: 1; transform: none; }
      .codex-mod-notice-card { background: var(--color-background-panel, var(--color-background-primary-soft-alpha));
        width: max-content; min-width: min(18rem, calc(100vw - 32px)); max-width: min(21rem, calc(100vw - 32px));
        overflow: hidden; position: relative;
        display: flex; align-items: flex-start; gap: 6px; padding: 11px 8px 12px 14px; }
      .codex-mod-notice-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .codex-mod-notice-summary { overflow-wrap: anywhere; }
      .codex-mod-notice-more { color: var(--color-content-blue, #3566f0); text-decoration: none; white-space: nowrap;
        cursor: pointer; }
      .codex-mod-notice-more:hover { text-decoration: underline; text-underline-offset: 2px; }
      .codex-mod-notice-close { flex: none; border: 0; background: transparent; border-radius: 8px; padding: 4px;
        cursor: pointer; display: inline-flex; margin-top: -2px; }
      .codex-mod-notice-close:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
      .codex-mod-notice-actions { display: flex; margin-top: 8px; }
      .codex-mod-notice-progress { position: absolute; left: 0; bottom: 0; height: 2px; width: 100%;
        background: color-mix(in srgb, currentColor 22%, transparent); transform-origin: left; }
      .codex-mod-notice.codex-mod-pill { pointer-events: none; }
      .codex-mod-pill-inner { display: inline-flex; align-items: center; gap: 7px; padding: 5px 11px;
        border-radius: 999px; white-space: nowrap;
        background: var(--color-background-panel, var(--color-background-primary-soft-alpha)); }
      .codex-mod-spinner { width: 11px; height: 11px; border-radius: 999px; border: 1.5px solid currentColor;
        border-right-color: transparent; animation: codex-mod-spin 700ms linear infinite; opacity: .7;
        margin-left: -2px; }
      @keyframes codex-mod-spin { to { transform: rotate(360deg); } }
    `;
    document.head.append(style);

    const closeIcon =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    // Codex's primary button in its small composer size.
    const actionButtonClass =
      "no-drag cursor-interaction items-center select-none focus:outline-none " +
      "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 gap-1 " +
      "border whitespace-nowrap flex rounded-lg h-token-button-composer-sm px-2.5 py-0 " +
      "text-sm leading-[18px] border-default bg-primary-solid enabled:hover:bg-text/80 " +
      "text-primary-solid disabled:opacity-60";

    function stack() {
      let node = document.querySelector(".codex-mod-notices");
      if (node == null) {
        node = document.createElement("div");
        node.className = "codex-mod-notices";
        document.body.append(node);
      }
      return node;
    }

    function mount(node) {
      stack().append(node);
      requestAnimationFrame(() => requestAnimationFrame(() => (node.dataset.open = "true")));
    }

    function dismiss(node) {
      node.dataset.open = "false";
      setTimeout(() => node.remove(), 260);
    }

    function dismissPills() {
      document.querySelectorAll(".codex-mod-pill").forEach(dismiss);
    }

    // At most two lines, always ending in the link; a longer summary is cut
    // at a word and ends in an ellipsis before the link.
    function fitSummary(node, text, link) {
      const lineHeight = parseFloat(getComputedStyle(node).lineHeight) || 16;
      const fits = () => node.getBoundingClientRect().height <= lineHeight * 2 + 1;
      const render = (shown, cut) => {
        node.textContent = shown === "" ? "" : cut ? `${shown.trimEnd()}… ` : `${shown} `;
        if (link != null) node.append(link);
      };
      render(text, false);
      if (fits()) return;
      const words = text.split(" ");
      let low = 0;
      let high = words.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        render(words.slice(0, middle).join(" "), true);
        if (fits()) low = middle;
        else high = middle - 1;
      }
      render(words.slice(0, low).join(" "), low > 0);
    }

    // Hovering the card pauses the countdown its progress line shows.
    function autoDismiss(node, box, ms) {
      const bar = document.createElement("div");
      bar.className = "codex-mod-notice-progress text-secondary";
      box.append(bar);
      let remaining = ms;
      let startedAt = 0;
      let timer = null;
      const run = () => {
        if (timer != null || box.matches(":hover")) return;
        startedAt = performance.now();
        bar.style.transition = `transform ${remaining}ms linear`;
        bar.style.transform = "scaleX(0)";
        timer = setTimeout(() => dismiss(node), remaining);
      };
      const pause = () => {
        if (timer == null) return;
        clearTimeout(timer);
        timer = null;
        remaining -= performance.now() - startedAt;
        bar.style.transition = "transform 200ms ease";
        bar.style.transform = `scaleX(${Math.max(0, remaining / ms)})`;
      };
      box.addEventListener("mouseenter", pause);
      box.addEventListener("mouseleave", () => setTimeout(run, 0));
      setTimeout(run, 300);
    }

    // A card stays until it is closed, or for `ms` with a countdown. Its
    // summary ends in a link to the release notes of `version` unless `notes`
    // is false. An `action` is a button under the text.
    function card(kind, { title, summary = "", version, onClose = () => {}, notes = true, action = null, ms = null }) {
      const node = document.createElement("div");
      node.className = `codex-mod-notice ${kind}`;
      node.setAttribute("role", "status");
      const box = document.createElement("div");
      box.className = "codex-mod-notice-card rounded-2xl border border-default shadow-lg";
      const text = document.createElement("div");
      text.className = "codex-mod-notice-text";
      const titleNode = document.createElement("div");
      titleNode.className = "text-sm font-medium text-default";
      titleNode.textContent = title;
      const summaryNode = document.createElement("div");
      summaryNode.className = "codex-mod-notice-summary text-xs leading-4 text-secondary";
      const link = document.createElement("a");
      link.className = "codex-mod-notice-more";
      link.textContent = "Read more";
      link.href = "#";
      link.addEventListener("click", (event) => {
        event.preventDefault();
        console.log(`__codex_mod_release_notes__:${version}`);
      });
      text.append(titleNode, summaryNode);
      if (action != null) {
        const actions = document.createElement("div");
        actions.className = "codex-mod-notice-actions";
        const button = document.createElement("button");
        button.type = "button";
        button.className = `codex-mod-notice-button ${actionButtonClass}`;
        button.textContent = action.label;
        button.addEventListener("click", () => action.onClick(button));
        actions.append(button);
        text.append(actions);
      }
      box.append(text);
      const close = document.createElement("button");
      close.type = "button";
      close.className = "codex-mod-notice-close text-secondary";
      close.setAttribute("aria-label", "Dismiss");
      close.innerHTML = closeIcon;
      close.addEventListener("click", () => {
        dismiss(node);
        onClose();
      });
      box.append(close);
      node.append(box);
      mount(node);
      if (summary.trim() === "" && !notes) {
        summaryNode.remove();
      } else {
        fitSummary(summaryNode, summary.trim(), notes ? link : null);
      }
      if (ms != null) {
        autoDismiss(node, box, ms);
      }
      return node;
    }

    // The release a reload brought: one the user applied, or one applied
    // while Codex was closed, announced when it opens again.
    function update({ version, summary = "", ms = 8000 }) {
      dismissPills();
      document.querySelectorAll(".codex-mod-update").forEach(dismiss);
      card("codex-mod-update", { title: `Codex Mod updated to ${version}`, summary, version, ms });
      return true;
    }

    // An installed update that waits for the user while Codex runs. Applying
    // reloads the windows, which come back in their chat with the draft, and
    // the release card that follows carries the summary. The host repeats the
    // offer on every check, so an open card is kept, and a closed one comes
    // back with the next window load.
    let closedReady = null;
    function ready({ version }) {
      const open = [...document.querySelectorAll(".codex-mod-ready")];
      if (
        closedReady === version ||
        open.some((node) => node.dataset.version === version && node.dataset.open !== "false")
      ) {
        return true;
      }
      open.forEach(dismiss);
      const node = card("codex-mod-ready", {
        title: `Codex Mod ${version} update ready`,
        summary: "Apply it now or it installs when you quit Codex.",
        version,
        notes: false,
        onClose: () => {
          closedReady = version;
        },
        action: {
          label: "Apply now",
          onClick: (button) => {
            button.disabled = true;
            button.textContent = "Applying…";
            console.log("__codex_mod_update_install__");
          },
        },
      });
      node.dataset.version = version;
      return true;
    }

    // A newer release that waits for a Codex update. The host repeats the
    // notice on every check until it is closed, so an open card is kept.
    function incompatible({ version, codex, minimum = null }) {
      const key = `${version}|${codex}`;
      const open = [...document.querySelectorAll(".codex-mod-incompatible")];
      if (open.some((node) => node.dataset.key === key && node.dataset.open !== "false")) {
        return true;
      }
      open.forEach(dismiss);
      const node = card("codex-mod-incompatible", {
        title: `Codex Mod ${version} update waiting`,
        summary:
          minimum != null
            ? `It needs Codex ${minimum} or newer and installs on its own once you update Codex.`
            : "It does not fully support this Codex yet and installs on its own after the next Codex update.",
        version,
        notes: false,
        onClose: () => console.log(`__codex_mod_incompatible_dismissed__:${codex}`),
        // Codex's own update check, as its application menu offers it, when
        // the patcher found it in this build.
        action:
          typeof globalThis.__codexCheckForCodexUpdates === "function"
            ? { label: "Update Codex", onClick: () => globalThis.__codexCheckForCodexUpdates() }
            : null,
      });
      node.dataset.key = key;
      return true;
    }

    function pill(label, { spinner = false, ms = null } = {}) {
      dismissPills();
      const node = document.createElement("div");
      node.className = "codex-mod-notice codex-mod-pill";
      node.setAttribute("role", "status");
      const inner = document.createElement("div");
      inner.className = "codex-mod-pill-inner border border-default shadow-sm text-xs text-secondary";
      if (spinner) {
        const icon = document.createElement("span");
        icon.className = "codex-mod-spinner";
        inner.append(icon);
      }
      const text = document.createElement("span");
      text.textContent = label;
      inner.append(text);
      node.append(inner);
      mount(node);
      if (ms != null) setTimeout(() => dismiss(node), ms);
      return true;
    }

    globalThis.__codexModNotices = {
      pill,
      clearPills: dismissPills,
      update,
      ready,
      incompatible,
    };
    return true;
  }

  return `(${installNotices.toString()})()`;
}

function pillScript(label, options = {}) {
  return `globalThis.__codexModNotices?.pill(${JSON.stringify(label)}, ${JSON.stringify(options)}) === true`;
}

function clearPillsScript() {
  return "globalThis.__codexModNotices?.clearPills(), true";
}

function updateNoticeScript(notice) {
  return `globalThis.__codexModNotices?.update(${JSON.stringify(notice)}) === true`;
}

function incompatibleNoticeScript(notice) {
  return `globalThis.__codexModNotices?.incompatible(${JSON.stringify(notice)}) === true`;
}

function readyNoticeScript(notice) {
  return `globalThis.__codexModNotices?.ready(${JSON.stringify(notice)}) === true`;
}

function modalPromptScript(options) {
  return (
    "typeof globalThis.__codexShowModal===\"function\"" +
    `?globalThis.__codexShowModal(${JSON.stringify(options)}):undefined`
  );
}

// A "Codex Mod" page of its own in Settings: an entry in a trailing
// "Extensions" group of the settings navigation that shows the release the
// host serves and the mod's own settings. Codex's router knows nothing of the
// page, so while it is selected it stands in for the page Codex shows, and
// any other navigation entry brings that one back.
function settingsSectionScript(version, describe, browserLogin, updates, officeBridge) {
  function installSettingsSection(release, build, login, updateStatus, office) {
    const sectionId = "codex-mod-version";
    const navSectionId = "codex-mod-settings-nav-section";
    const navItemId = "codex-mod-settings-nav";
    const pageId = "codex-mod-settings-page";
    const existing = globalThis.__codexVersionController;
    if (existing != null) {
      existing.update(release, build, login, updateStatus, office);
      return true;
    }
    let currentRelease = release;
    let currentBuild = build;
    let currentLogin = login;
    let currentUpdates = updateStatus;
    let currentOffice = office;
    // Set while the mod's page is shown: the entry Codex still considers
    // current, with what was changed on it and on its page to step aside.
    let selection = null;

    const puzzleIcon =
      '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19.439 7.85c-.049.322.059.648' +
      '.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276' +
      'c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837' +
      'l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29' +
      'c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877' +
      'l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303' +
      '.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676' +
      '.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877' +
      '.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z"/></svg>';

    function settingsNav() {
      return document.querySelector("nav.sidebar-navigation");
    }

    // Codex's own entries; the back entry, which Codex only shows without the
    // app rail, is a link.
    function codexEntries(nav) {
      return [...nav.querySelectorAll("button, a")].filter(
        (entry) => entry.getAttribute("role") !== "link" && entry.closest(`#${navSectionId}`) == null,
      );
    }

    function classDiff(from, to) {
      const toClasses = new Set(String(to?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean));
      return String(from?.getAttribute("class") ?? "")
        .split(/\s+/)
        .filter((name) => name !== "" && !toClasses.has(name));
    }

    // How an entry looks when current and when not, read from Codex's current
    // entry and another one, so the styling follows whatever Codex ships.
    function entryStates(current, other) {
      const parts = (entry) => [entry, entry.firstElementChild, entry.querySelector("svg")];
      const [a, b] = [parts(current), parts(other)];
      return a.map((node, index) => ({ active: classDiff(node, b[index]), inactive: classDiff(b[index], node) }));
    }

    function applyEntryState(entry, states, active) {
      const nodes = [entry, entry.firstElementChild, entry.querySelector("svg")];
      nodes.forEach((node, index) => {
        if (node == null) return;
        const { active: on, inactive: off } = states[index];
        node.classList.remove(...(active ? off : on));
        node.classList.add(...(active ? on : off));
      });
      if (active) entry.setAttribute("aria-current", "page");
      else entry.removeAttribute("aria-current");
    }

    // The navigation group and entry, cloned from Codex's last group and one
    // of its entries that is not current.
    function createNavSection(nav) {
      const groups = [...nav.querySelectorAll(".group\\/nav-section")];
      const lastGroup = groups.at(-1);
      const template = codexEntries(nav).findLast((entry) => entry.getAttribute("aria-current") !== "page");
      if (lastGroup == null || template == null || lastGroup.children.length < 2) {
        return null;
      }
      const group = lastGroup.cloneNode(false);
      group.id = navSectionId;
      const title = lastGroup.firstElementChild.cloneNode(true);
      const titleText = title.querySelector("div") ?? title;
      titleText.textContent = "Extensions";
      const list = lastGroup.children[1].cloneNode(false);
      const entry = template.cloneNode(true);
      entry.id = navItemId;
      for (const name of ["aria-current", "aria-label", "data-settings-panel-slug", "data-state", "data-sidebar-cycle-item"]) {
        entry.removeAttribute(name);
      }
      entry.setAttribute("aria-label", "Codex Mod");
      const icon = entry.querySelector("svg");
      if (icon != null) {
        icon.outerHTML = puzzleIcon;
      }
      const label = entry.querySelector(".text-fade-truncate") ?? entry.firstElementChild?.lastElementChild;
      if (label != null) {
        label.textContent = "Codex Mod";
      }
      entry.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        select();
      });
      list.append(entry);
      group.append(title, list);
      return group;
    }

    // The page Codex shows next to the navigation: its header with the h1
    // and, below it, the scroll container with the section list.
    function codexPage() {
      const heading = [...document.querySelectorAll("h1")].find(
        (h1) => h1.closest("nav") == null && h1.closest(`#${pageId}`) == null,
      );
      // The header sits inside the scroll container where settings are a
      // page of their own, and beside it where they open in a dialog.
      let page = heading?.parentElement ?? null;
      while (page != null && !page.matches(".overflow-y-auto") && page.querySelector(".overflow-y-auto") == null) {
        page = page.parentElement;
      }
      return page;
    }

    // The mod's page, built from shallow copies of Codex's page so it keeps
    // the same width, padding, heading and scrolling.
    function createPage(codex) {
      const page = codex.cloneNode(false);
      page.id = pageId;
      page.style.display = "";
      const header = [...codex.children].find((child) => child.querySelector("h1") != null);
      if (header != null) {
        const headerCopy = header.cloneNode(true);
        const h1 = headerCopy.querySelector("h1");
        h1.textContent = "Codex Mod";
        // The line below the heading describes the page, as on Codex's own.
        const [description, ...rest] = headerCopy.querySelectorAll("h1 ~ *");
        if (description?.children.length === 0) {
          description.textContent = "Updates and integrations of Codex Mod";
        } else {
          rest.unshift(description);
        }
        for (const node of [...rest, ...headerCopy.querySelectorAll("[class*='actions'] > *, [class*='navigation']")]) {
          node?.remove();
        }
        page.append(headerCopy);
      }
      // The wrappers from the body down to the one holding Codex's section
      // list carry the scrolling and the content width.
      let body = [...codex.children].find((child) => child !== header) ?? null;
      let container = page;
      while (body != null) {
        const copy = body.cloneNode(false);
        container.append(copy);
        container = copy;
        const child = body.children.length === 1 ? body.firstElementChild : null;
        body = child == null || child.matches("[class*='settings-section-gap']") ? null : child;
      }
      const list = document.createElement("div");
      list.className = "flex flex-col gap-[var(--settings-section-gap,--spacing(10))]";
      learnSectionClasses(codex);
      list.append(createSection());
      container.append(list);
      return page;
    }

    function select() {
      const nav = settingsNav();
      const codex = codexPage();
      const current = nav && codexEntries(nav).find((entry) => entry.getAttribute("aria-current") === "page");
      const ours = document.getElementById(navItemId);
      if (nav == null || codex == null || current == null || ours == null) {
        return;
      }
      if (selection != null) {
        return;
      }
      const other = codexEntries(nav).find((entry) => entry !== current) ?? ours;
      const states = entryStates(current, other);
      selection = {
        current,
        codex,
        states,
        classes: [current, current.firstElementChild, current.querySelector("svg")].map((node) => node?.getAttribute("class")),
        display: codex.style.display,
      };
      applyEntryState(current, states, false);
      current.setAttribute("aria-current", "false");
      applyEntryState(ours, states, true);
      codex.style.display = "none";
      codex.after(createPage(codex));
      render();
    }

    function deselect() {
      if (selection == null) {
        return;
      }
      const { current, codex, states, classes, display } = selection;
      selection = null;
      document.getElementById(pageId)?.remove();
      codex.style.display = display;
      [current, current.firstElementChild, current.querySelector("svg")].forEach((node, index) => {
        if (node != null && classes[index] != null) node.setAttribute("class", classes[index]);
      });
      current.setAttribute("aria-current", "page");
      const ours = document.getElementById(navItemId);
      if (ours != null) {
        applyEntryState(ours, states, false);
      }
    }

    // Any other entry, or Codex switching pages itself, gives the content
    // area back to Codex.
    document.addEventListener(
      "click",
      (event) => {
        const entry = event.target instanceof Element ? event.target.closest("nav.sidebar-navigation button, nav.sidebar-navigation a") : null;
        if (entry != null && entry.id !== navItemId) {
          deselect();
        }
      },
      true,
    );

    function buildLabel() {
      return currentBuild && currentBuild !== currentRelease
        ? `${currentRelease} (${currentBuild})`
        : currentRelease;
    }

    function createSection() {
      const sections = document.createElement("div");
      sections.id = sectionId;
      sections.className = "flex flex-col gap-[var(--settings-section-gap,--spacing(10))]";
      const versionRow = createRow("Version", "The release the mod host serves to this window");
      const value = document.createElement("span");
      value.dataset.codexModVersion = "";
      value.className = "text-sm text-secondary tabular-nums select-text";
      rowControls(versionRow).append(value);
      const browser = createGroup("Chrome extension", [createBrowserLoginRow()]);
      browser.dataset.codexModBrowserLoginGroup = "";
      const updates = createGroup("Updates", [createAutomaticUpdatesRow(), createUpdateRow()]);
      sections.append(
        createGroup("About", [versionRow]),
        updates,
        createGroup("Office add-ins", [createOfficeBridgeRow()]),
        browser,
        createGroup("Uninstall", [createUninstallRow()]),
      );
      return sections;
    }

    // Codex's settings section as this build draws it: the section, the
    // chain of elements down to its title, the list of rows, and a row and
    // its parts. A section on the page Codex shows overrides these classes,
    // so the mod's page keeps matching once Codex restyles its own. Some of
    // Codex's styling keys off an ancestor of the page, such as the flat
    // sections of newer builds, and applies to these classes as well.
    const sectionClasses = {
      section: "flex flex-col",
      header: [
        "flex justify-between group-data-[density=compact]/settings:min-h-0 group-data-[density=compact]/settings:pb-3 " +
          "[[data-settings-panel]_&]:border-b [[data-settings-panel]_&]:border-default gap-4 items-center pb-1.5 min-h-toolbar",
        "flex min-w-0 flex-1 flex-col gap-0.5 group-data-[density=compact]/settings:gap-0.75",
        "font-medium text-default group-data-[density=compact]/settings:text-lg " +
          "group-data-[density=compact]/settings:leading-5 text-base",
      ],
      list:
        "flex flex-col [&>*:not(:last-child)]:relative [&>*:not(:last-child)]:after:pointer-events-none " +
        "[&>*:not(:last-child)]:after:absolute [&>*:not(:last-child)]:after:inset-x-4 " +
        "[&>*:not(:last-child)]:after:bottom-0 [&>*:not(:last-child)]:after:h-px " +
        "[&>*:not(:last-child)]:after:bg-border [&>*:not(:last-child)]:after:content-[''] " +
        "[--settings-row-padding-inline:initial] rounded-2xl overflow-hidden border border-default " +
        "[--settings-surface-background:initial] group-data-[density=compact]/settings:border-0 " +
        "group-data-[density=compact]/settings:ring-1 group-data-[density=compact]/settings:ring-inset " +
        "group-data-[density=compact]/settings:ring-border [[data-settings-panel]_&]:rounded-none " +
        "[[data-settings-panel]_&]:border-0 [[data-settings-panel]_&]:ring-0 " +
        "[[data-settings-panel]_&]:[--settings-row-padding-inline:0px] " +
        "[[data-settings-panel]_&]:[--settings-surface-background:transparent] " +
        "[[data-settings-panel]_&]:overflow-visible [[data-settings-panel]_&>*:not(:last-child)]:after:inset-x-0",
      row: "@container/settings-row px-[var(--settings-row-padding-inline,--spacing(4))] items-center flex justify-between gap-6 py-3",
      lead: "flex min-w-0 gap-3 items-center flex-1",
      text:
        "flex min-w-0 flex-1 flex-col gap-0.5 group-data-[density=compact]/settings:leading-4.5 " +
        "[[data-settings-panel]_&]:gap-1 [[data-settings-panel]_&]:py-0.5 text-sm",
      label: "min-w-0 break-words text-default font-medium",
      detail:
        "min-w-0 text-xs leading-4 text-wrap break-words text-secondary [[data-settings-panel]_&]:[font-size:inherit] " +
        "[[data-settings-panel]_&]:[line-height:inherit] [[data-settings-panel]_&]:font-normal",
      controls: "flex max-w-full items-center justify-end gap-2 shrink-0 min-w-[min(--spacing(40),40cqw)] empty:min-w-0",
    };

    // Read from a row like the mod's own, a label with a detail line beside
    // a switch, in a titled section. Rows with other controls lay them out
    // differently, and the classes stay as they are on a page without one.
    function learnSectionClasses(codex) {
      const classOf = (node) => node.getAttribute("class") ?? "";
      for (const row of codex.querySelectorAll("section [data-settings-search-entry]")) {
        const section = row.closest("section");
        const header = section.firstElementChild;
        const [lead, controls] = row.children;
        const text = lead?.lastElementChild;
        const [label, detail] = text?.children ?? [];
        if (
          row.children.length !== 2 ||
          controls.querySelector("[role=switch]") == null ||
          label == null ||
          detail == null ||
          header.contains(row)
        ) {
          continue;
        }
        const chain = [];
        for (let node = header; node != null; node = node.firstElementChild) {
          chain.push(classOf(node));
        }
        Object.assign(sectionClasses, {
          section: classOf(section),
          header: chain,
          list: classOf(row.parentElement),
          row: classOf(row),
          lead: classOf(lead),
          text: classOf(text),
          label: classOf(label),
          detail: classOf(detail),
          controls: classOf(controls),
        });
        return;
      }
    }

    function element(tag, className) {
      const node = document.createElement(tag);
      node.className = className;
      return node;
    }

    function createGroup(titleText, rows) {
      const section = element("section", sectionClasses.section);
      let title = section;
      for (const className of sectionClasses.header) {
        const node = element("div", className);
        title.append(node);
        title = node;
      }
      title.textContent = titleText;
      const list = element("div", sectionClasses.list);
      list.append(...rows);
      section.append(list);
      return section;
    }

    function createRow(labelText, detailText) {
      const row = element("div", sectionClasses.row);
      const lead = element("div", sectionClasses.lead);
      const text = element("div", sectionClasses.text);
      const label = element("div", sectionClasses.label);
      label.textContent = labelText;
      const detail = element("div", sectionClasses.detail);
      detail.textContent = detailText;
      text.append(label, detail);
      lead.append(text);
      row.append(lead, element("div", sectionClasses.controls));
      return row;
    }

    function rowControls(row) {
      return row.lastElementChild;
    }

    // Codex's own settings switch, as this build draws it. A switch Codex
    // shows elsewhere in the window, checked or not, overrides these classes,
    // so the mod's switches keep matching once Codex restyles its own.
    const switchClasses = {
      track: {
        checked:
          "relative inline-flex shrink-0 items-center rounded-full transition-colors duration-basic " +
          "ease-out bg-(--switch-track-color-checked) h-5 w-8",
        unchecked:
          "relative inline-flex shrink-0 items-center rounded-full transition-colors duration-basic " +
          "ease-out bg-text/10 h-5 w-8",
      },
      thumb:
        "rounded-full border shadow-sm transition-transform duration-basic ease-out " +
        "data-[state=unchecked]:translate-x-0 border-current bg-current text-(color:--switch-thumb-color) " +
        "data-[state=checked]:text-(color:--switch-thumb-color-checked) h-4 w-4 " +
        "data-[state=unchecked]:translate-x-[2px] data-[state=checked]:translate-x-[14px] " +
        "rtl:data-[state=unchecked]:-translate-x-[2px] rtl:data-[state=checked]:-translate-x-[14px]",
    };

    function learnSwitchClasses() {
      for (const state of ["checked", "unchecked"]) {
        const native = [...document.querySelectorAll(`button[role=switch][data-state=${state}]:not(:disabled)`)].find(
          (button) => button.closest(`#${pageId}`) == null && button.firstElementChild?.firstElementChild != null,
        );
        if (native != null) {
          switchClasses.track[state] = native.firstElementChild.className;
          switchClasses.thumb = native.firstElementChild.firstElementChild.className;
        }
      }
    }

    function createSwitch(labelText, onClick) {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "switch");
      button.setAttribute("aria-label", labelText);
      button.className =
        "inline-flex items-center text-sm focus-visible:outline-none focus-visible:ring-2 " +
        "focus-visible:ring-ring focus-visible:rounded-full cursor-interaction shrink-0";
      const track = document.createElement("span");
      track.setAttribute("aria-hidden", "true");
      track.append(document.createElement("span"));
      button.append(track);
      button.addEventListener("click", onClick);
      return button;
    }

    function renderSwitch(button, enabled) {
      learnSwitchClasses();
      const state = enabled ? "checked" : "unchecked";
      const track = button.firstElementChild;
      const thumb = track.firstElementChild;
      button.dataset.state = state;
      button.setAttribute("aria-checked", String(enabled));
      track.dataset.state = state;
      thumb.dataset.state = state;
      if (track.className !== switchClasses.track[state]) track.className = switchClasses.track[state];
      if (thumb.className !== switchClasses.thumb) thumb.className = switchClasses.thumb;
    }

    function createBrowserLoginRow() {
      const labelText = "Enable Chrome extension fix";
      const row = createRow(
        labelText,
        "Lets the Google Chrome extension work under custom profiles, as long as a valid ChatGPT login exists",
      );
      row.dataset.codexModBrowserLogin = "";
      rowControls(row).append(createSwitch(labelText, () => openBrowserLoginRestartPrompt(!currentLogin.enabled)));
      return row;
    }

    function renderBrowserLogin(row) {
      row.closest("[data-codex-mod-browser-login-group]").style.display = currentLogin.available ? "" : "none";
      renderSwitch(row.querySelector("button"), currentLogin.enabled);
    }

    const officeBridgeLabel = "Use the add-in's ChatGPT login";

    function createOfficeBridgeRow() {
      const row = createRow(officeBridgeLabel, "");
      row.dataset.codexModOfficeBridge = "";
      rowControls(row).append(createSwitch(officeBridgeLabel, () => openOfficeBridgeRestartPrompt(!currentOffice.enabled)));
      return row;
    }

    function renderOfficeBridge(row) {
      const detail =
        currentOffice.enabled && currentOffice.problem != null
          ? `The bridge did not start, so Codex keeps its own Excel and PowerPoint tools: ${currentOffice.problem}`
          : "Lets Codex control Excel and PowerPoint through the ChatGPT add-in under any account or custom " +
            "profile, as long as the add-in's login is saved in the account switcher";
      setRowText(row, officeBridgeLabel, detail);
      renderSwitch(row.querySelector("button"), currentOffice.enabled);
    }

    function createAutomaticUpdatesRow() {
      const labelText = "Automatic updates";
      const row = createRow(labelText, "");
      row.dataset.codexModAutomaticUpdates = "";
      rowControls(row).append(
        createSwitch(labelText, () => {
          console.log(`__codex_mod_automatic_updates__:${currentUpdates.automatic ? "off" : "on"}`);
        }),
      );
      return row;
    }

    // Codex's toolbar button in settings rows, without its colors.
    const buttonClasses =
      "no-drag cursor-interaction items-center select-none disabled:cursor-default aria-disabled:cursor-default " +
      "focus:outline-hidden disabled:opacity-40 aria-disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring " +
      "focus-visible:ring-offset-0 whitespace-nowrap flex border gap-1 rounded-button-toolbar border-transparent " +
      "button-toolbar py-0 text-sm leading-[18px]";

    function createUpdateRow() {
      const row = createRow("", "");
      row.dataset.codexModUpdate = "";
      const button = document.createElement("button");
      button.type = "button";
      button.className = `${buttonClasses} text-default bg-text/5 not-disabled:not-aria-disabled:hover:bg-text/10`;
      button.addEventListener("click", () => {
        console.log("__codex_mod_update_install__");
      });
      rowControls(row).append(button);
      return row;
    }

    function setRowText(row, labelText, detailText) {
      const [label, detail] = row.firstElementChild.lastElementChild.children;
      if (label.textContent !== labelText) label.textContent = labelText;
      if (detail.textContent !== detailText) detail.textContent = detailText;
      detail.style.display = detailText === "" ? "none" : "";
    }

    // What the update row says and offers, from the host's update status.
    function updateRowState(status) {
      const check = { button: "Check Now", enabled: true };
      const release = status.available == null ? "The update" : `Codex Mod ${status.available}`;
      if (!status.selfUpdating) {
        return {
          label: status.latest == null ? "Updates" : `Latest release: ${status.latest}`,
          detail: "This development checkout does not update itself",
          button: null,
        };
      }
      if (status.activity === "installing") {
        return {
          label: status.available == null ? "Installing the update" : `Installing Codex Mod ${status.available}`,
          detail: "Codex reloads its windows once it is ready",
          button: "Install",
          enabled: false,
        };
      }
      if (status.activity === "waiting") {
        return {
          label: `${release} is ready`,
          detail: "Installs when you apply it or quit Codex",
          button: "Apply Now",
          enabled: true,
        };
      }
      if (status.activity === "checking") {
        return { label: "Checking for updates", detail: "", button: "Check Now", enabled: false };
      }
      if (status.available != null && status.blocked != null) {
        const target = status.blocked.minimum != null ? ` to ${status.blocked.minimum} or newer` : "";
        return {
          label: `Codex Mod ${status.available} needs a newer Codex`,
          detail: status.automatic
            ? `It installs together with the next Codex update${target}`
            : `Update Codex${target} to install it`,
          button: "Install",
          enabled: false,
        };
      }
      if (status.available != null) {
        return {
          label: `Codex Mod ${status.available} is available`,
          detail: status.automatic ? "Downloads and installs at the next check" : "Automatic updates are off",
          button: "Install",
          enabled: true,
        };
      }
      if (status.error != null) {
        return { label: "Update check failed", detail: status.error.replace(/^update check failed: /, ""), ...check };
      }
      if (status.latest != null) {
        return { label: "Codex Mod is up to date", detail: "", ...check };
      }
      return { label: "Updates", detail: "Not checked yet", ...check };
    }

    function renderUpdates(section) {
      const automaticRow = section.querySelector("[data-codex-mod-automatic-updates]");
      setRowText(
        automaticRow,
        "Automatic updates",
        currentUpdates.selfUpdating
          ? "Downloads new releases and installs them when you apply them or quit Codex"
          : "Development checkouts do not update themselves",
      );
      const toggle = automaticRow.querySelector("button");
      renderSwitch(toggle, currentUpdates.selfUpdating && currentUpdates.automatic);
      toggle.disabled = !currentUpdates.selfUpdating;
      toggle.classList.toggle("opacity-60", toggle.disabled);
      toggle.classList.toggle("cursor-not-allowed", toggle.disabled);
      toggle.classList.toggle("cursor-interaction", !toggle.disabled);
      const row = section.querySelector("[data-codex-mod-update]");
      const state = updateRowState(currentUpdates);
      setRowText(row, state.label, state.detail);
      const button = row.querySelector("button");
      button.style.display = state.button == null ? "none" : "";
      if (state.button != null && button.textContent !== state.button) button.textContent = state.button;
      button.disabled = !state.enabled;
    }

    // The switch takes effect when the host next launches Codex, so the
    // prompt only decides whether that happens now; dismissing it means later.
    function openBrowserLoginRestartPrompt(enable) {
      const report = (restart) =>
        console.log(`__codex_browser_login__:${enable ? "on" : "off"}:${restart ? "restart" : "later"}`);
      const show = globalThis.__codexShowModal;
      if (typeof show !== "function") {
        report(false);
        return;
      }
      void show({
        message: `Restart Codex to ${enable ? "enable" : "disable"} the Chrome extension fix?`,
        detail: enable
          ? "The Chrome extension then also works under custom profiles. It sends the " +
            "address of every page it acts on, and usage data, to OpenAI under your " +
            "ChatGPT account. Model requests still go to the active profile. Restarting " +
            "stops running threads. Otherwise the fix applies the next time Codex starts."
          : "Restarting stops running threads. Otherwise the fix stays active until " +
            "Codex restarts.",
        buttons: ["Later", "Restart Now"],
        defaultId: 1,
        cancelId: 0,
      }).then((index) => report(index === 1));
    }

    function openOfficeBridgeRestartPrompt(enable) {
      const report = (restart) =>
        console.log(`__codex_office_bridge__:${enable ? "on" : "off"}:${restart ? "restart" : "later"}`);
      const show = globalThis.__codexShowModal;
      if (typeof show !== "function") {
        report(false);
        return;
      }
      void show({
        message: `Restart Codex to ${enable ? "use" : "stop using"} the add-in's ChatGPT login?`,
        detail: enable
          ? "Codex then reaches Excel and PowerPoint through whichever saved ChatGPT login the add-in " +
            "is signed in with. Model requests still go to the active profile. Restarting stops " +
            "running threads. Otherwise the change applies the next time Codex starts."
          : "Codex then reaches the add-ins only while the add-in's own login is active in Codex. " +
            "Restarting stops running threads. Otherwise the change applies the next time Codex starts.",
        buttons: ["Later", "Restart Now"],
        defaultId: 1,
        cancelId: 0,
      }).then((index) => report(index === 1));
    }

    function createUninstallRow() {
      const row = createRow("Uninstall Codex Mod", "Removes Codex Mod entirely and restarts Codex");
      const button = document.createElement("button");
      button.type = "button";
      button.className =
        `${buttonClasses} bg-danger-soft-alpha not-disabled:not-aria-disabled:hover:bg-danger-soft-alpha-hover ` +
        "text-danger-soft-alpha";
      button.textContent = "Uninstall";
      button.addEventListener("click", () => {
        openUninstallConfirmation();
      });
      rowControls(row).append(button);
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

    function renderNav(nav) {
      let group = document.getElementById(navSectionId);
      if (group != null && group.parentElement?.closest("nav") !== nav) {
        group.remove();
        group = null;
      }
      // The settings search filters Codex's entries, and lists its matches
      // without groups; the mod's entry follows the query.
      const query = (document.getElementById("settings-search")?.value ?? "").trim().toLowerCase();
      const shown = query === "" || "codex mod extensions".includes(query);
      if (group != null) {
        group.style.display = shown ? "" : "none";
      }
      const lastGroup = [...nav.querySelectorAll(".group\\/nav-section")].filter((node) => node.id !== navSectionId).at(-1);
      if (lastGroup == null) {
        return;
      }
      if (group == null) {
        group = createNavSection(nav);
        if (group == null) {
          return;
        }
        group.style.display = shown ? "" : "none";
      }
      if (lastGroup.nextElementSibling !== group) {
        lastGroup.after(group);
      }
    }

    function render() {
      const nav = settingsNav();
      if (nav == null) {
        selection = null;
        document.getElementById(pageId)?.remove();
        return;
      }
      renderNav(nav);
      if (selection != null) {
        const page = document.getElementById(pageId);
        // Codex marks a page current again once it navigates by itself, or
        // it rebuilt the page ours stands in for.
        const navigated = codexEntries(nav).some((entry) => entry.getAttribute("aria-current") === "page");
        if (navigated || !selection.codex.isConnected || page == null) {
          const { codex } = selection;
          selection = null;
          page?.remove();
          if (codex.isConnected) codex.style.display = "";
        }
      }
      const section = document.getElementById(sectionId);
      if (section == null) {
        return;
      }
      renderBrowserLogin(section.querySelector("[data-codex-mod-browser-login]"));
      renderOfficeBridge(section.querySelector("[data-codex-mod-office-bridge]"));
      renderUpdates(section);
      const value = section.querySelector("[data-codex-mod-version]");
      const labelText = buildLabel();
      if (value.textContent !== labelText) {
        value.textContent = labelText;
      }
    }

    globalThis.__codexVersionController = {
      update(nextRelease, nextBuild, nextLogin, nextUpdates, nextOffice) {
        currentRelease = nextRelease;
        currentBuild = nextBuild;
        currentLogin = nextLogin;
        currentUpdates = nextUpdates;
        currentOffice = nextOffice;
        render();
      },
    };
    let scheduled = false;
    new MutationObserver(() => {
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          render();
        });
      }
    }).observe(document.body, { childList: true, subtree: true });
    document.addEventListener("input", (event) => {
      if (event.target?.id === "settings-search") render();
    });
    render();
    return true;
  }

  return (
    `(${installSettingsSection.toString()})` +
    `(${JSON.stringify(version)},${JSON.stringify(describe ?? null)},${JSON.stringify(browserLogin)},` +
    `${JSON.stringify(updates)},${JSON.stringify(officeBridge)})`
  );
}

// The controls injected at the start of every document the window loads, so
// they are in place before Codex renders its first screen. The parser creates
// the body before Codex's deferred bundles run, and the controls attach
// to it. Each script runs on its own, so one that fails leaves the others.
// The host sends every later render of the controls through this as well:
// an evaluation that reaches a window just after it reloads runs in the new
// document before it has a body, which a controller that observes the body
// cannot install in.
function documentStartScript(scripts) {
  const body = scripts.map((script) => `try{${script}\n}catch(error){console.error("[codex-mod]",error)}`).join("\n");
  return (
    `(()=>{if(window.top!==window||location.protocol!=="app:")return;const run=()=>{${body}};` +
    "if(document.body!=null){run();return}" +
    "const observer=new MutationObserver(()=>{if(document.body!=null){observer.disconnect();run()}});" +
    "observer.observe(document,{childList:true,subtree:true})})()"
  );
}

function activeProviderSyncScript(provider) {
  const serialized = JSON.stringify(provider);
  return `try{localStorage.setItem("__codex_active_provider",${serialized})}catch{}`;
}

module.exports = {
  OPENAI_PROVIDER,
  documentStartScript,
  AUTH_SYNC_INTERVAL_MS,
  BUDGET_POLL_INTERVAL_MS,
  USAGE_POLL_INTERVAL_MS,
  LIVE_USAGE_TRUST_MS,
  FAILED_POLLS_BEFORE_ALERT,
  accountFromAuthJson,
  accountSnapshotPath,
  accountsDir,
  activeAccount,
  tryAcquireAccountLock,
  writeFileAtomic,
  removeAccountSnapshot,
  activeProvider,
  activeProviderSyncScript,
  authFilePath,
  backUpActiveAccount,
  budgetRows,
  codexBinary,
  codexHome,
  configuredProviders,
  fetchBudget,
  providerBudgetSource,
  readAccountRateLimits,
  isRevokedTokenError,
  markModBuildScript,
  modPresentScript,
  rateLimitsFromUsage,
  usageStatusScript,
  settingsSectionScript,
  modalScript,
  modalPromptScript,
  activeThreadScript,
  clearPillsScript,
  readyNoticeScript,
  noticesScript,
  pillScript,
  settleThreadRouteScript,
  threadRouteUrl,
  updateNoticeScript,
  incompatibleNoticeScript,
  sidebarProfileScript,
  threadGuardScript,
  storedAccounts,
  usageRows,
  writeAccount,
  writeProvider,
};
