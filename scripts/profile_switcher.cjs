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
    if (!response.ok) {
      return null;
    }
    const body = await response.json();
    const info = body?.info ?? body;
    const spend = Number(info?.spend);
    const maxBudget = Number(info?.max_budget);
    if (!Number.isFinite(spend) || !Number.isFinite(maxBudget) || maxBudget <= 0) {
      return null;
    }
    return {
      spend,
      maxBudget,
      resetAt: typeof info?.budget_reset_at === "string" ? info.budget_reset_at : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function codexBinary() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, "codex") : null,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ].filter((candidate) => candidate != null);
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
    return Promise.resolve(null);
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
    const timer = setTimeout(() => finish(null), USAGE_FETCH_TIMEOUT_MS);
    const send = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        finish(null);
      }
    };

    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
    child.stdin.on("error", () => finish(null));
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
          finish(message.result ?? null);
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

function windowLabel(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return "usage";
  }
  if (minutes === 10080) {
    return "weekly";
  }
  if (minutes === 1440) {
    return "daily";
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
  const plan = claims["https://api.openai.com/auth"]?.chatgpt_plan_type;
  const label =
    email == null
      ? accountId
      : typeof plan === "string" && plan !== ""
        ? `${email} (${plan})`
        : email;
  return { accountId, label };
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

  const stat = fs.statSync(configPath);
  const backupPath = `${configPath}.bak.before-profile-switcher`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(configPath, backupPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backupPath, stat.mode);
  }

  writeFileAtomic(configPath, updated, stat.mode);
  return true;
}

async function restartCodexHost(BrowserWindow) {
  const windows = BrowserWindow.getAllWindows().filter(
    (window) => !window.isDestroyed() && !window.webContents.isDestroyed(),
  );
  for (const window of windows) {
    try {
      const restarted = await window.webContents.executeJavaScript(
        "globalThis.__codexProfileRestart ? globalThis.__codexProfileRestart() : false",
      );
      if (restarted === true) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

async function reloadCodexWindows(BrowserWindow) {
  await new Promise((resolve) => setTimeout(resolve, 750));
  const windows = BrowserWindow.getAllWindows().filter(
    (window) => !window.isDestroyed() && !window.webContents.isDestroyed(),
  );
  if (windows.length === 0) {
    return false;
  }

  let reloaded = false;
  for (const window of windows) {
    try {
      window.webContents.reload();
      reloaded = true;
    } catch {
      continue;
    }
  }
  return reloaded;
}

function relaunchApplication(app) {
  try {
    app.relaunch({ execPath: process.execPath, args: process.argv.slice(1) });
  } catch {
    // The detached macOS launcher below is the fallback.
  }

  const currentPid = String(process.pid);
  const fallback = spawn(
    "/bin/sh",
    [
      "-c",
      `while /bin/kill -0 ${currentPid} 2>/dev/null; do /bin/sleep 0.1; done; exec /usr/bin/open -b com.openai.codex`,
    ],
    { detached: true, stdio: "ignore" },
  );
  fallback.unref();
  app.exit(0);
}

const UPDATE_MENU_ID = "codex-mod-menu";
const UPDATE_STATE_POLL_MS = 2000;
const UPDATE_STATE_WATCH_MS = 5000;
const UPDATE_CHECK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_AGENT_LABEL = "dev.codex-mod.watch";

function readVersionMetadata() {
  try {
    const metadata = JSON.parse(
      fs.readFileSync(path.join(__dirname, "codex-mod-version.json"), "utf8"),
    );
    return typeof metadata === "object" && metadata != null ? metadata : null;
  } catch {
    return null;
  }
}

function readUpdateState(statePath) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return typeof state === "object" && state != null ? state : null;
  } catch {
    return null;
  }
}

function agentPlistPath(metadata) {
  const label = metadata?.agentLabel || DEFAULT_AGENT_LABEL;
  return path.join(os.homedir(), "Library/LaunchAgents", `${label}.plist`);
}

function launchAgentInstalled(metadata) {
  return fs.existsSync(agentPlistPath(metadata));
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      resolve({ code: null, stderr: String(error) });
      return;
    }
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ code: null, stderr: stderr || String(error) }));
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

async function installLaunchAgent(metadata) {
  const script = path.join(metadata.repoRoot, "scripts/manage_launch_agent.py");
  if (!fs.existsSync(script)) {
    throw new Error(`the launch agent installer is missing: ${script}`);
  }
  const asar = path.join(process.resourcesPath, "app.asar");
  const pythons = [metadata.pythonPath, "/usr/bin/python3", "python3"].filter(Boolean);
  let failure = "";
  for (const python of pythons) {
    const result = await runCommand(python, [script, "install", "--asar", asar]);
    if (result.code === 0) {
      return;
    }
    failure = result.stderr.trim() || `exit code ${result.code}`;
    // A non-null exit code means the installer itself ran and failed; trying
    // another interpreter would just repeat the same failure.
    if (result.code != null) {
      break;
    }
  }
  throw new Error(failure || "could not run the launch agent installer");
}

async function kickstartLaunchAgent(metadata) {
  const label = metadata.agentLabel || DEFAULT_AGENT_LABEL;
  const service = `gui/${process.getuid()}/${label}`;
  const first = await runCommand("/bin/launchctl", ["kickstart", service]);
  if (first.code === 0) {
    return;
  }
  await installLaunchAgent(metadata);
  const second = await runCommand("/bin/launchctl", ["kickstart", service]);
  if (second.code !== 0) {
    throw new Error(second.stderr.trim() || "launchctl kickstart failed");
  }
}

function installUpdateMenu(app, dialog, accountsBridge) {
  const { Menu, MenuItem } = require("electron");
  const metadata = readVersionMetadata();
  const statePath = metadata?.statePath || path.join(codexHome(), ".codex-mod-state.json");
  const updateRequestPath =
    metadata?.updateRequestPath || path.join(codexHome(), ".codex-mod-update-request");
  const checkRequestPath =
    metadata?.checkRequestPath || path.join(codexHome(), ".codex-mod-check-request");
  const configPath =
    metadata?.configPath || path.join(codexHome(), ".codex-mod-config.json");
  const progressPath =
    metadata?.progressPath || path.join(codexHome(), ".codex-mod-progress.json");
  const uninstallRequestPath =
    metadata?.uninstallRequestPath ||
    path.join(codexHome(), ".codex-mod-uninstall-request");
  let busy = false;
  let uninstalled = false;
  let lastHandledCheckedAt = readUpdateState(statePath)?.checked_at ?? 0;
  // The state written at startup describes the ASAR this process loaded, so a
  // different hash later means an update landed, even when a follow-up agent
  // tick already overwrote the "updated" result with "unchanged".
  let baselineAsarSha = readUpdateState(statePath)?.asar_sha256 ?? null;
  let restartPending = false;

  function updateLanded(state) {
    return (
      state.result === "updated" ||
      (typeof state.asar_sha256 === "string" &&
        baselineAsarSha != null &&
        state.asar_sha256 !== baselineAsarSha)
    );
  }

  function versionLabel() {
    if (metadata == null) {
      return "Version unknown";
    }
    const version = metadata.version || "0.0.0";
    return metadata.describe && metadata.describe !== version
      ? `Version ${version} (${metadata.describe})`
      : `Version ${version}`;
  }

  function setBusy(next) {
    busy = next;
    // The rebuilt Mod item reads the busy flag for its enabled states.
    refreshApplicationMenu();
  }

  async function reportBusy() {
    await dialog.showMessageBox({
      type: "info",
      message: "Codex Mod is already working",
      detail: "An update check, install, or uninstall is still running.",
      buttons: ["OK"],
    });
  }

  async function offerRestart(state) {
    const { response } = await dialog.showMessageBox({
      type: "info",
      message: `Codex Mod updated to ${state?.describe || state?.release || "the latest version"}`,
      detail: "Restart Codex to apply the update.",
      buttons: ["Restart Now", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      relaunchApplication(app);
    }
  }

  async function reportOutcome(state, manual, failTitle = "Codex Mod update failed") {
    const checkedAt = state.checked_at ?? 0;
    const alreadyHandled = checkedAt <= lastHandledCheckedAt;
    lastHandledCheckedAt = Math.max(lastHandledCheckedAt, checkedAt);
    if (state.result === "uninstalled") {
      uninstalled = true;
      setBusy(busy);
      if (typeof state.asar_sha256 === "string") {
        baselineAsarSha = state.asar_sha256;
      }
      if (!alreadyHandled || manual) {
        if (state.restored === false) {
          await dialog.showMessageBox({
            type: "warning",
            message: "Codex Mod agent removed",
            detail:
              "No pristine backup was found, so the patched app was left in " +
              "place until the next Codex update replaces it. Reinstall with " +
              "make patch.",
            buttons: ["OK"],
          });
        } else {
          const { response } = await dialog.showMessageBox({
            type: "info",
            message: "Codex Mod was uninstalled",
            detail: "The original Codex app was restored. Restart Codex to finish.",
            buttons: ["Restart Now", "Later"],
            defaultId: 0,
            cancelId: 1,
          });
          if (response === 0) {
            relaunchApplication(app);
          }
        }
      }
      return;
    }
    if (updateLanded(state)) {
      const firstSighting = !restartPending && !alreadyHandled;
      restartPending = true;
      // Move the baseline so quiet background ticks do not re-prompt; a
      // manual check still offers the restart below.
      if (typeof state.asar_sha256 === "string") {
        baselineAsarSha = state.asar_sha256;
      }
      if (firstSighting || manual) {
        await offerRestart(state);
      }
      return;
    }
    if (!manual) {
      return;
    }
    if (restartPending) {
      await offerRestart(state);
      return;
    }
    if (state.result === "failed") {
      await dialog.showMessageBox({
        type: "error",
        message: failTitle,
        detail: `${state.error || "See the patch log for details."}\n\nLog: ${
          metadata?.errorLogPath || "~/Library/Logs/codex-mod/patch-error.log"
        }`,
        buttons: ["OK"],
      });
      return;
    }
    if (state.remote_reachable === false) {
      await dialog.showMessageBox({
        type: "error",
        message: "Failed to check for updates",
        detail: "The update server could not be reached. Try again later.",
        buttons: ["OK"],
      });
      return;
    }
    await dialog.showMessageBox({
      type: "info",
      message: "Codex Mod is up to date",
      detail: versionLabel(),
      buttons: ["OK"],
    });
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  // The answer to a request is the first state stamped by a run that started
  // AFTER the request marker was consumed; a run already in flight when the
  // marker was written stamps its own, unrelated result first. While the
  // marker sits unconsumed the kickstart is repeated, because launchd ignores
  // kickstarts of an already-running job.
  async function awaitAgentAnswer(requestPath) {
    const deadline = Date.now() + UPDATE_CHECK_TIMEOUT_MS;
    let baseline = readUpdateState(statePath)?.checked_at ?? 0;
    let markerConsumed = false;
    let lastKickAt = 0;

    while (Date.now() < deadline) {
      if (!markerConsumed && !fs.existsSync(requestPath)) {
        markerConsumed = true;
      }
      if (!markerConsumed && Date.now() - lastKickAt >= 5000) {
        lastKickAt = Date.now();
        await kickstartLaunchAgent(metadata);
      }
      const state = readUpdateState(statePath);
      if (state?.checked_at != null && state.checked_at > baseline) {
        baseline = state.checked_at;
        if (markerConsumed) {
          return state;
        }
      }
      await sleep(UPDATE_STATE_POLL_MS);
    }
    try {
      fs.unlinkSync(requestPath);
    } catch {
      // Already consumed; nothing to clean up.
    }
    return null;
  }

  async function runAgentRequest(requestPath, waitTimeoutTitle, run) {
    if (metadata == null || uninstalled) {
      return;
    }
    if (busy) {
      await reportBusy();
      return;
    }
    setBusy(true);
    try {
      fs.writeFileSync(requestPath, "");
      if (!launchAgentInstalled(metadata)) {
        await installLaunchAgent(metadata);
      }
      const state = await awaitAgentAnswer(requestPath);
      if (state == null) {
        await dialog.showMessageBox({
          type: "error",
          message: waitTimeoutTitle,
          detail: `No result after ${UPDATE_CHECK_TIMEOUT_MS / 60000} minutes. See ${
            metadata.errorLogPath || "the patch log"
          }.`,
          buttons: ["OK"],
        });
        return;
      }
      await run(state);
    } finally {
      setBusy(false);
    }
  }

  function createProgressWindow(version) {
    const { BrowserWindow, nativeTheme } = require("electron");
    const dark = nativeTheme.shouldUseDarkColors;
    let win = null;
    try {
      win = new BrowserWindow({
        width: 380,
        height: 104,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        show: false,
        title: "Codex Mod",
        backgroundColor: dark ? "#1e1e1e" : "#f2f2f2",
      });
      const html = `<!doctype html><meta charset="utf-8"><title>Codex Mod</title>
        <body style="font-family:-apple-system,sans-serif;margin:18px;color:${
          dark ? "#e8e8e8" : "#222"
        }">
        <div id="label" style="font-size:13px;margin-bottom:10px">Installing Codex Mod ${version}…</div>
        <div style="background:rgba(127,127,127,.25);border-radius:4px;height:8px;overflow:hidden">
          <div id="bar" style="background:#0a84ff;height:100%;width:4%;transition:width .4s ease"></div>
        </div>
        <script>function update(p,l){document.getElementById("bar").style.width=p+"%";
          if(l)document.getElementById("label").textContent=l}</script>`;
      win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
      win.once("ready-to-show", () => {
        if (win != null && !win.isDestroyed()) {
          win.show();
        }
      });
    } catch {
      win = null;
    }

    // Codex's Electron build lacks some BrowserWindow methods, and an
    // uncaught throw here would spam main-process error dialogs, so progress
    // reporting must never escape this callback.
    const setDockProgress = (value) => {
      try {
        if (typeof win?.setProgressBar === "function") {
          win.setProgressBar(value);
        }
      } catch {
        // Dock progress is decorative.
      }
    };
    const startedAt = Date.now();
    const timer = setInterval(() => {
      try {
        if (win == null || win.isDestroyed()) {
          return;
        }
        const progress = JSON.parse(fs.readFileSync(progressPath, "utf8"));
        // Progress files from earlier runs describe someone else's patch.
        if ((Number(progress.at) || 0) * 1000 < startedAt - 5000) {
          return;
        }
        const percent = Math.min(100, Math.max(0, Number(progress.percent) || 0));
        setDockProgress(percent / 100);
        const label = `Installing Codex Mod ${version}: ${progress.label || "working"}…`;
        win.webContents
          .executeJavaScript(`update(${percent}, ${JSON.stringify(label)})`)
          .catch(() => {});
      } catch {
        // The progress file may be missing or mid-write; try again next tick.
      }
    }, 500);

    return {
      close() {
        clearInterval(timer);
        try {
          if (win != null && !win.isDestroyed()) {
            setDockProgress(-1);
            win.close();
          }
        } catch {
          // The window is already gone.
        }
        win = null;
      },
    };
  }

  async function installUpdate(version) {
    const progress = createProgressWindow(version);
    try {
      await runAgentRequest(
        updateRequestPath,
        "Codex Mod update timed out",
        (state) => reportOutcome(state, true),
      );
    } catch (error) {
      dialog.showErrorBox(
        "Could not install the Codex Mod update",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      progress.close();
    }
  }

  async function checkForUpdates() {
    let installVersion = null;
    try {
      await runAgentRequest(
        checkRequestPath,
        "Codex Mod update check timed out",
        async (state) => {
          if (state.result === "update-available") {
            lastHandledCheckedAt = Math.max(
              lastHandledCheckedAt,
              state.checked_at ?? 0,
            );
            const available = state.remote_release || "a new release";
            const { response } = await dialog.showMessageBox({
              type: "info",
              message: `Codex Mod ${available} is available`,
              detail: `Installed version: ${
                metadata?.version || "unknown"
              }. Install the update now?`,
              buttons: ["Install Now", "Later"],
              defaultId: 0,
              cancelId: 1,
            });
            if (response === 0) {
              installVersion = available;
            }
            return;
          }
          if (state.result === "check-failed") {
            lastHandledCheckedAt = Math.max(
              lastHandledCheckedAt,
              state.checked_at ?? 0,
            );
            await dialog.showMessageBox({
              type: "error",
              message: "Failed to check for updates",
              detail: state.error || "The update server could not be reached.",
              buttons: ["OK"],
            });
            return;
          }
          await reportOutcome(state, true);
        },
      );
    } catch (error) {
      dialog.showErrorBox(
        "Could not check for Codex Mod updates",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    if (installVersion != null) {
      await installUpdate(installVersion);
    }
  }

  async function uninstallMod() {
    if (busy || metadata == null || uninstalled) {
      return;
    }
    const { response } = await dialog.showMessageBox({
      type: "warning",
      message: "Uninstall Codex Mod?",
      detail:
        "This restores the original Codex app and removes the background " +
        "agent. Reinstall later by running make patch in the repository.",
      buttons: ["Uninstall", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) {
      return;
    }
    try {
      await runAgentRequest(
        uninstallRequestPath,
        "Codex Mod uninstall timed out",
        (state) => reportOutcome(state, true, "Codex Mod uninstall failed"),
      );
    } catch (error) {
      dialog.showErrorBox(
        "Could not uninstall Codex Mod",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  function readModConfig() {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return typeof config === "object" && config != null ? config : {};
    } catch {
      return {};
    }
  }

  function automaticUpdatesEnabled() {
    return readModConfig().automaticUpdates !== false;
  }

  // Codex's shell converts the JS menu to its native menu only when a NEW
  // menu object is set: live item mutations and re-setting the same instance
  // both leave the native menu untouched. A refresh therefore rebuilds the
  // top level with fresh items; the app's entries keep their existing
  // submenu objects, and the Mod item is rebuilt from current state.
  function cloneTopLevelItem(item) {
    if (item.id === UPDATE_MENU_ID) {
      return buildModMenuItem();
    }
    const template = {
      label: item.label,
      enabled: item.enabled,
      visible: item.visible,
    };
    if (item.role) {
      template.role = item.role;
    }
    if (item.submenu) {
      template.submenu = item.submenu;
    }
    return new MenuItem(template);
  }

  function refreshApplicationMenu() {
    try {
      const current = Menu.getApplicationMenu();
      if (current == null || current.getMenuItemById(UPDATE_MENU_ID) == null) {
        return;
      }
      const rebuilt = new Menu();
      for (const item of current.items) {
        rebuilt.append(cloneTopLevelItem(item));
      }
      applyApplicationMenu(rebuilt);
    } catch {
      // Menu refresh is cosmetic.
    }
  }

  function syncAutomaticUpdatesItems() {
    // The rebuilt Mod item reads the config file, so refreshing IS the sync.
    refreshApplicationMenu();
  }

  function setAutomaticUpdates(enabled) {
    try {
      const config = { ...readModConfig(), automaticUpdates: enabled };
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    } catch (error) {
      dialog.showErrorBox(
        "Could not change automatic updates",
        error instanceof Error ? error.message : String(error),
      );
    }
    syncAutomaticUpdatesItems();
  }

  function buildAccountsSubmenu() {
    const accounts = accountsBridge.accounts();
    const profiles = accountsBridge
      .providers()
      .filter((option) => option.provider !== OPENAI_PROVIDER);
    const entries = [];
    if (accounts.length > 0) {
      entries.push({ label: "Accounts", enabled: false });
      entries.push(
        ...accounts.map((account) => ({
          label: account.label,
          type: "checkbox",
          checked: account.accountId === accountsBridge.activeAccountId(),
          click: () => void accountsBridge.switchAccount(account.accountId),
        })),
      );
      entries.push({ type: "separator" });
    }
    if (profiles.length > 0) {
      entries.push({ label: "Profiles", enabled: false });
      entries.push(
        ...profiles.map((option) => ({
          label: option.label,
          type: "checkbox",
          checked: option.provider === accountsBridge.activeProvider(),
          click: () => void accountsBridge.switchProvider(option.provider),
        })),
      );
      entries.push({ type: "separator" });
    }
    entries.push({
      id: "codex-mod-account-add",
      label: "Add Account…",
      click: () => void accountsBridge.addAccount(),
    });
    return entries;
  }

  function buildSubmenu() {
    const auto = automaticUpdatesEnabled();
    return Menu.buildFromTemplate([
      { id: "codex-mod-version", label: versionLabel(), enabled: false },
      { type: "separator" },
      {
        id: "codex-mod-check",
        label: "Check for Updates…",
        enabled: !busy && metadata != null && !uninstalled,
        click: () => void checkForUpdates(),
      },
      {
        id: "codex-mod-auto",
        label: "Automatic Updates",
        enabled: metadata != null && !uninstalled,
        submenu: [
          {
            id: "codex-mod-auto-on",
            label: "On",
            type: "radio",
            checked: auto,
            click: () => setAutomaticUpdates(true),
          },
          {
            id: "codex-mod-auto-off",
            label: "Off",
            type: "radio",
            checked: !auto,
            click: () => setAutomaticUpdates(false),
          },
        ],
      },
      { type: "separator" },
      {
        id: "codex-mod-accounts",
        label: "Accounts & Profiles",
        submenu: buildAccountsSubmenu(),
      },
      { type: "separator" },
      {
        id: "codex-mod-uninstall",
        label: "Uninstall…",
        enabled: !busy && metadata != null && !uninstalled,
        click: () => void uninstallMod(),
      },
    ]);
  }

  function buildModMenuItem() {
    return new MenuItem({
      id: UPDATE_MENU_ID,
      label: "Mod",
      submenu: buildSubmenu(),
    });
  }

  function withUpdateMenu(menu) {
    if (menu == null || menu.getMenuItemById(UPDATE_MENU_ID) != null) {
      return menu;
    }
    const item = buildModMenuItem();
    const windowIndex = menu.items.findIndex(
      (existing) =>
        existing.role === "window" ||
        existing.role === "windowmenu" ||
        existing.label === "Window",
    );
    if (windowIndex === -1) {
      menu.append(item);
    } else {
      menu.insert(windowIndex, item);
    }
    return menu;
  }

  const applyApplicationMenu = Menu.setApplicationMenu.bind(Menu);
  Menu.setApplicationMenu = (menu) => applyApplicationMenu(withUpdateMenu(menu));
  app.whenReady().then(() => {
    const current = Menu.getApplicationMenu();
    if (current != null) {
      applyApplicationMenu(withUpdateMenu(current));
    }
  });

  // The watcher patches in the background, and a manual make patch writes the
  // same state file, so both surface the identical restart dialog here.
  fs.watchFile(statePath, { interval: UPDATE_STATE_WATCH_MS }, () => {
    const state = readUpdateState(statePath);
    if (state?.checked_at == null || state.checked_at <= lastHandledCheckedAt) {
      return;
    }
    if (updateLanded(state) || state.result === "uninstalled") {
      void reportOutcome(state, false);
    } else {
      lastHandledCheckedAt = Math.max(lastHandledCheckedAt, state.checked_at);
    }
  });

  return refreshApplicationMenu;
}

function sidebarProfileScript(provider, providers, account, accounts) {
  function installSidebarProfileSwitcher(
    initialProvider,
    initialProviders,
    initialAccount,
    initialAccounts,
  ) {
    const containerId = "codex-profile-switcher";
    const menuId = "codex-profile-switcher-menu";
    const loginPanelId = "codex-login-accounts";
    const styleId = "codex-profile-switcher-style";
    const openaiProvider = "openai";
    const requestPrefix = "__codex_profile_switch__:";
    const accountRequestPrefix = "__codex_account_switch__:";
    const addAccountRequest = "__codex_account_add__";
    const activeProviderStorageKey = "__codex_active_provider";
    const buttonStyleStorageKey = "__codex_profile_switcher_button_style";
    const existingController = globalThis.__codexProfileSidebarController;
    if (existingController != null) {
      existingController.setProviders(initialProviders);
      existingController.setAccounts?.(initialAccounts);
      existingController.setProvider(initialProvider);
      existingController.setAccount?.(initialAccount);
      existingController.ensure();
      return true;
    }

    let currentProvider = initialProvider;
    let providerOptions = initialProviders;
    let currentAccount = initialAccount ?? null;
    let accountOptions = Array.isArray(initialAccounts) ? initialAccounts : [];

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
        .querySelector(`#${containerId} > button`)
        ?.setAttribute("aria-expanded", "false");
      document
        .querySelector(`#${loginPanelId} [data-login-toggle]`)
        ?.setAttribute("aria-expanded", "false");
    }

    function renderProvider() {
      const button = document.querySelector(`#${containerId} > button`);
      if (button != null) {
        const activeLabel =
          currentProvider === openaiProvider && currentAccount != null
            ? accountLabel(currentAccount)
            : providerLabel(currentProvider);
        button.setAttribute(
          "aria-label",
          `Codex profile: ${activeLabel}. Switch profile`,
        );
      }

      const menu = document.getElementById(menuId);
      if (menu != null && menu.dataset.signature !== menuSignature()) {
        populateMenu(menu);
      }

      document.querySelectorAll(`#${menuId} [data-account]`).forEach((option) => {
        // Accounts ride the built-in provider, so their checkmark only shows
        // while it is active; otherwise the active profile would be marked
        // twice.
        const selected =
          currentProvider === openaiProvider &&
          option.dataset.account === currentAccount;
        option.setAttribute("aria-selected", String(selected));
        const check = option.querySelector("[data-check]");
        if (check != null) {
          check.hidden = !selected;
        }
      });

      document.querySelectorAll(`#${menuId} [data-provider]`).forEach((option) => {
        const selected = option.dataset.provider === currentProvider;
        option.setAttribute("aria-selected", String(selected));
        const label = option.querySelector("[data-provider-label]");
        const labelText = providerLabel(option.dataset.provider);
        if (label != null && label.textContent !== labelText) {
          label.textContent = labelText;
        }
        const check = option.querySelector("[data-check]");
        if (check != null) {
          check.hidden = !selected;
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
      closeMenu();
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
        closeMenu();
        return;
      }
      const previousAccount = currentAccount;
      const previousProvider = currentProvider;
      currentAccount = accountId;
      currentProvider = openaiProvider;
      renderProvider();
      closeMenu();
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
        #${containerId} { display: flex; flex: none; }
        #${containerId} [data-switch-icon] {
          fill: none;
          stroke: currentColor;
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-width: 1.7;
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
        #${menuId} [data-check] {
          align-items: center;
          display: flex;
          flex: none;
          height: 16px;
          justify-content: center;
          margin-left: auto;
          order: 2;
          text-align: center;
          width: 16px;
        }
        #${menuId} [data-check] svg {
          fill: none;
          height: 14px;
          stroke: currentColor;
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-width: 2;
          width: 14px;
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

    function isHelpButton(button) {
      const label = button?.getAttribute("aria-label");
      return label === "Open help menu" || label === "Open Codex docs";
    }

    function findFooterAnchorButton() {
      const labelled = [
        ...document.querySelectorAll(
          'button[aria-label="Open help menu"], button[aria-label="Open Codex docs"]',
        ),
      ].find((button) => button.getClientRects().length > 0);
      if (labelled != null) {
        return labelled;
      }

      return [...document.querySelectorAll("button")]
        .filter((button) => {
          if (button.closest(`#${containerId}`) != null) {
            return false;
          }
          const rect = button.getBoundingClientRect();
          return (
            rect.width > 0 &&
            rect.width <= 72 &&
            rect.left < Math.min(480, window.innerWidth * 0.4) &&
            rect.bottom > window.innerHeight - 80
          );
        })
        .sort(
          (left, right) =>
            right.getBoundingClientRect().right - left.getBoundingClientRect().right,
        )[0];
    }

    function menuOption(kind, value, label, onSelect) {
      const option = document.createElement("button");
      option.type = "button";
      option.dataset[kind] = value;
      option.setAttribute("role", "option");
      const check = document.createElement("span");
      check.dataset.check = "";
      check.hidden = true;
      const checkIcon = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg",
      );
      checkIcon.setAttribute("viewBox", "0 0 16 16");
      checkIcon.setAttribute("aria-hidden", "true");
      const checkPath = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      checkPath.setAttribute("d", "m3.25 8.25 3 3 6.5-6.5");
      checkIcon.append(checkPath);
      check.append(checkIcon);
      option.append(check);
      const text = document.createElement("span");
      text.dataset[`${kind}Label`] = "";
      text.textContent = label;
      option.append(text);
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
      closeMenu();
      console.info(addAccountRequest);
    }

    // The signed-out screen has no sidebar, so it gets its own pill list of
    // saved accounts and profiles under the sign-in card.
    function findLoginAnchor() {
      if (document.getElementById(containerId) != null) {
        return null;
      }
      return (
        [...document.querySelectorAll("button")].find(
          (button) =>
            button.getClientRects().length > 0 &&
            /^continue to sign in$/i.test(button.textContent.trim()),
        ) ?? null
      );
    }

    // The login toggle opens the same dropdown card the sidebar switcher
    // uses, so entries read as menu rows instead of more sign-in buttons.
    function openLoginMenu(toggle) {
      let menu = document.getElementById(menuId);
      if (menu == null) {
        menu = document.createElement("div");
        menu.id = menuId;
        menu.hidden = true;
        menu.setAttribute("role", "listbox");
        menu.setAttribute("aria-label", "Codex profile");
        document.body.append(menu);
      }
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
      const zoom =
        menu.currentCSSZoom ??
        (Number.parseFloat(getComputedStyle(menu).zoom) || 1);
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
      const secondary = [...host.querySelectorAll("button")].find(
        (button) =>
          button.dataset.loginToggle == null &&
          /^sign in another way$/i.test(button.textContent.trim()),
      );
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
        for (const { accountId, label } of accountOptions) {
          entries.push(menuOption("account", accountId, label, selectAccount));
        }
      } else {
        entries.push(
          menuOption(
            "provider",
            openaiProvider,
            providerLabel(openaiProvider),
            selectProvider,
          ),
        );
      }
      const profiles = providerOptions.filter(
        (option) => option.provider !== openaiProvider,
      );
      if (profiles.length > 0) {
        const separator = document.createElement("div");
        separator.dataset.menuSeparator = "";
        entries.push(separator, menuHeading("Profiles"));
        for (const { provider, label } of profiles) {
          entries.push(menuOption("provider", provider, label, selectProvider));
        }
      }
      menu.dataset.signature = menuSignature();
      menu.replaceChildren(...entries);
    }

    function buildMenu(button) {
      document.getElementById(menuId)?.remove();
      const menu = document.createElement("div");
      menu.id = menuId;
      menu.hidden = true;
      menu.setAttribute("role", "listbox");
      menu.setAttribute("aria-label", "Codex profile");
      populateMenu(menu);

      document.body.append(menu);
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const opening = menu.hidden;
        closeMenu();
        if (!opening) {
          return;
        }
        const rect = button.getBoundingClientRect();
        menu.hidden = false;
        // The menu is zoomed to match the app UI, and left/top of a zoomed
        // fixed element are interpreted in that zoomed coordinate space.
        const zoom =
          menu.currentCSSZoom ??
          (Number.parseFloat(getComputedStyle(menu).zoom) || 1);
        const menuRect = menu.getBoundingClientRect();
        menu.style.left = `${
          Math.min(Math.max(8, rect.left), window.innerWidth - menuRect.width - 8) /
          zoom
        }px`;
        menu.style.top = `${Math.max(8, rect.top - menuRect.height - 6) / zoom}px`;
        button.setAttribute("aria-expanded", "true");
      });
    }

    function resolveAnchorStyle(anchorButton) {
      const anchorStyle = {
        button: anchorButton.getAttribute("class"),
        icon: anchorButton.querySelector("svg")?.getAttribute("class") ?? null,
      };
      if (isHelpButton(anchorButton)) {
        try {
          localStorage.setItem(buttonStyleStorageKey, JSON.stringify(anchorStyle));
        } catch {
          // Keep the in-memory style even when persistence fails.
        }
        return anchorStyle;
      }
      try {
        const cached = localStorage.getItem(buttonStyleStorageKey);
        if (cached != null) {
          return JSON.parse(cached);
        }
      } catch {
        // Fall back to the anchor's own style below.
      }
      return anchorStyle;
    }

    function applyAnchorStyle(button, anchorStyle) {
      if (
        anchorStyle.button != null &&
        button.getAttribute("class") !== anchorStyle.button
      ) {
        button.setAttribute("class", anchorStyle.button);
      }
      const icon = button.querySelector("[data-switch-icon]");
      if (
        icon != null &&
        anchorStyle.icon != null &&
        icon.getAttribute("class") !== anchorStyle.icon
      ) {
        icon.setAttribute("class", anchorStyle.icon);
      }
    }

    function ensureSwitcher() {
      const anchorButton = findFooterAnchorButton();
      if (anchorButton == null) {
        return;
      }
      ensureStyle();

      let footerRow = anchorButton.parentElement;
      while (footerRow != null && !footerRow.classList.contains("h-toolbar")) {
        footerRow = footerRow.parentElement;
      }
      if (footerRow == null) {
        return;
      }

      const anchorStyle = resolveAnchorStyle(anchorButton);
      const current = document.getElementById(containerId);
      if (current?.parentElement === footerRow) {
        const currentButton = current.querySelector("button");
        if (currentButton != null) {
          applyAnchorStyle(currentButton, anchorStyle);
        }
        renderProvider();
        return;
      }
      current?.remove();

      let anchorSlot = anchorButton;
      while (anchorSlot.parentElement !== footerRow && anchorSlot.parentElement != null) {
        anchorSlot = anchorSlot.parentElement;
      }
      const container = document.createElement("div");
      container.id = containerId;
      const button = anchorButton.cloneNode(true);
      for (const attribute of ["id", "aria-label", "aria-controls", "aria-describedby", "data-state"]) {
        button.removeAttribute(attribute);
      }
      button.setAttribute("aria-haspopup", "listbox");
      button.setAttribute("aria-expanded", "false");
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.dataset.switchIcon = "";
      icon.setAttribute("viewBox", "0 0 20 20");
      icon.setAttribute("aria-hidden", "true");
      icon.setAttribute("width", "16");
      icon.setAttribute("height", "16");
      for (const pathData of ["M3.5 6.25h10.75", "m11.5 3 3 3.25-3 3.25", "M16.5 13.75H5.75", "m8.5 17-3-3.25 3-3.25"]) {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", pathData);
        icon.append(path);
      }
      button.replaceChildren(icon);
      applyAnchorStyle(button, anchorStyle);
      container.append(button);
      footerRow.insertBefore(container, anchorSlot);
      buildMenu(button);
      renderProvider();
    }

    const controller = {
      ensure() {
        ensureSwitcher();
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
          (document.getElementById(containerId)?.contains(target) === true ||
            document.getElementById(loginPanelId)?.contains(target) === true ||
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
    persistProvider();
    ensureSwitcher();
    ensureLoginPanel();
    const fastAttach = setInterval(() => {
      if (
        document.getElementById(containerId) != null ||
        document.getElementById(loginPanelId) != null
      ) {
        clearInterval(fastAttach);
        return;
      }
      ensureSwitcher();
      ensureLoginPanel();
    }, 100);
    setInterval(() => {
      ensureSwitcher();
      ensureLoginPanel();
    }, 1500);
    return true;
  }

  return `(${installSidebarProfileSwitcher.toString()})(${JSON.stringify(provider)},${JSON.stringify(providers)},${JSON.stringify(account ?? null)},${JSON.stringify(accounts ?? [])})`;
}

function sidebarBudgetScript(payload) {
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
      `;
      document.head.append(style);
    }

    function findFooterRow() {
      const switcher = document.getElementById("codex-profile-switcher");
      if (switcher?.parentElement != null) {
        return switcher.parentElement;
      }
      const helpButton = [
        ...document.querySelectorAll(
          'button[aria-label="Open help menu"], button[aria-label="Open Codex docs"]',
        ),
      ].find((button) => button.getClientRects().length > 0);
      let row = helpButton?.parentElement ?? null;
      while (row != null && !row.classList.contains("h-toolbar")) {
        row = row.parentElement;
      }
      return row;
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
      resetElement.textContent =
        row.resetAt == null ? "" : `resets in ${formatReset(row.resetAt)}`;
      const amountRow = element.querySelector("[data-budget-amount-row]");
      if (resetElement.textContent !== "" && amountRow.scrollWidth > amountRow.clientWidth) {
        resetElement.textContent = "";
      }
    }

    function render() {
      const rows = currentPayload?.rows;
      if (rows == null || rows.length === 0) {
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
      if (box.childElementCount !== rows.length) {
        box.replaceChildren(...rows.map(createRow));
      }

      rows.forEach((row, index) => renderRow(box.children[index], row));
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
    render();
    setInterval(render, 1500);
    return true;
  }

  return `(${installSidebarBudget.toString()})(${JSON.stringify(payload)})`;
}

function installBudgetStatus(app, BrowserWindow) {
  let payload = null;
  let lastProvider = null;
  let polling = false;
  let usagePayload = null;
  let usageFetchedAt = 0;

  function broadcast() {
    const source = sidebarBudgetScript(payload);
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.executeJavaScript(source).catch(() => {});
      }
    }
  }

  async function poll() {
    if (polling) {
      return;
    }
    polling = true;
    try {
      let provider = OPENAI_PROVIDER;
      let source = null;
      try {
        const configText = fs.readFileSync(
          path.join(codexHome(), "config.toml"),
          "utf8",
        );
        provider = activeProvider(configText);
        source = providerBudgetSource(configText, provider);
      } catch {
        source = null;
      }

      const switched = provider !== lastProvider;
      lastProvider = provider;

      if (provider === OPENAI_PROVIDER) {
        if (switched) {
          usagePayload = null;
          usageFetchedAt = 0;
        }
        // The account read spawns an app server, so it runs far less often
        // than the poll that keeps the box in sync with the active provider.
        if (Date.now() - usageFetchedAt >= USAGE_POLL_INTERVAL_MS) {
          usageFetchedAt = Date.now();
          const rows = usageRows(await readAccountRateLimits());
          if (rows != null || usagePayload == null) {
            usagePayload = rows == null ? null : { rows };
          }
        }
        payload = usagePayload;
      } else if (source == null) {
        payload = null;
      } else {
        const fetched = await fetchBudget(source);
        if (fetched != null) {
          payload = { rows: budgetRows(fetched) };
        } else if (switched) {
          // Hide until the new provider answers; keep the last value on
          // transient failures of the same provider.
          payload = null;
        }
      }
      broadcast();
    } finally {
      polling = false;
    }
  }

  app.on("browser-window-created", (_event, window) => {
    window.webContents.on("did-finish-load", () => {
      broadcast();
      void poll();
    });
  });
  app.whenReady().then(() => {
    void poll();
    setInterval(() => void poll(), BUDGET_POLL_INTERVAL_MS);
  });

  return {
    refresh() {
      usageFetchedAt = 0;
      void poll();
    },
  };
}

function activeProviderSyncScript(provider) {
  const serialized = JSON.stringify(provider);
  return `try{localStorage.setItem("__codex_active_provider",${serialized})}catch{}`;
}

async function updateSidebarProvider(BrowserWindow, provider) {
  const source =
    `${activeProviderSyncScript(provider)};` +
    `globalThis.__codexSetActiveProfile?.(${JSON.stringify(provider)})`;
  await Promise.allSettled(
    BrowserWindow.getAllWindows()
      .filter((window) => !window.isDestroyed() && !window.webContents.isDestroyed())
      .map((window) => window.webContents.executeJavaScript(source)),
  );
}

async function updateSidebarAccount(BrowserWindow, accountId) {
  const source = `globalThis.__codexSetActiveAccount?.(${JSON.stringify(accountId)})`;
  await Promise.allSettled(
    BrowserWindow.getAllWindows()
      .filter((window) => !window.isDestroyed() && !window.webContents.isDestroyed())
      .map((window) => window.webContents.executeJavaScript(source)),
  );
}

function installSidebarSwitcher(
  app,
  BrowserWindow,
  getProvider,
  getProviders,
  switchProvider,
  getAccount,
  getAccounts,
  switchAccount,
  addAccount,
) {
  const attached = new WeakSet();
  const requestPrefix = "__codex_profile_switch__:";
  const accountRequestPrefix = "__codex_account_switch__:";
  const addAccountRequest = "__codex_account_add__";
  const attach = (window) => {
    if (window.isDestroyed() || attached.has(window)) {
      return;
    }
    attached.add(window);
    window.webContents.on("console-message", (_event, detailsOrLevel, message) => {
      const consoleMessage =
        typeof detailsOrLevel === "object" ? detailsOrLevel.message : message;
      if (typeof consoleMessage !== "string") {
        return;
      }
      if (consoleMessage.startsWith(requestPrefix)) {
        const provider = consoleMessage.slice(requestPrefix.length);
        if (getProviders().some((option) => option.provider === provider)) {
          void switchProvider(provider);
        }
      } else if (consoleMessage.startsWith(accountRequestPrefix)) {
        const accountId = consoleMessage.slice(accountRequestPrefix.length);
        if (getAccounts().some((option) => option.accountId === accountId)) {
          void switchAccount(accountId);
        }
      } else if (consoleMessage === addAccountRequest) {
        void addAccount();
      }
    });
    let renderTimer = null;
    const syncProvider = () => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents
          .executeJavaScript(activeProviderSyncScript(getProvider()))
          .catch(() => {});
      }
    };
    const render = () => {
      syncProvider();
      clearTimeout(renderTimer);
      renderTimer = setTimeout(() => {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents
            .executeJavaScript(
              sidebarProfileScript(
                getProvider(),
                getProviders(),
                getAccount(),
                getAccounts(),
              ),
            )
            .catch(() => {});
        }
      }, 100);
    };
    window.webContents.on("did-finish-load", render);
    if (!window.webContents.isLoadingMainFrame()) {
      render();
    }
  };

  app.on("browser-window-created", (_event, window) => attach(window));
  app.whenReady().then(() => BrowserWindow.getAllWindows().forEach(attach));
}

function install() {
  const { app, BrowserWindow, dialog } = require("electron");

  let currentProvider = OPENAI_PROVIDER;
  let providerOptions = [{ provider: OPENAI_PROVIDER, label: "OpenAI" }];
  try {
    const configPath = path.join(codexHome(), "config.toml");
    const configText = fs.readFileSync(configPath, "utf8");
    currentProvider = activeProvider(configText);
    providerOptions = configuredProviders(configText);
  } catch {
    currentProvider = OPENAI_PROVIDER;
  }

  let currentAccountId = null;
  let accountOptions = [];

  function syncAccountStore() {
    try {
      currentAccountId = backUpActiveAccount();
      accountOptions = storedAccounts();
    } catch {
      // A partially written auth.json is retried on the next sync.
    }
  }
  syncAccountStore();

  function broadcastSidebar() {
    const source = sidebarProfileScript(
      currentProvider,
      providerOptions,
      currentAccountId,
      accountOptions,
    );
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.executeJavaScript(source).catch(() => {});
      }
    }
  }

  async function switchProvider(nextProvider) {
    try {
      if (!writeProvider(nextProvider)) {
        return;
      }
      currentProvider = nextProvider;
      const configPath = path.join(codexHome(), "config.toml");
      providerOptions = configuredProviders(fs.readFileSync(configPath, "utf8"));
      await updateSidebarProvider(BrowserWindow, nextProvider);
      refreshModMenu();
      const restarted = await restartCodexHost(BrowserWindow);
      if (!restarted || !(await reloadCodexWindows(BrowserWindow))) {
        relaunchApplication(app);
      }
    } catch (error) {
      dialog.showErrorBox(
        "Could not switch Codex profile",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // An account entry stands for the built-in provider under that login, so
  // selecting one activates both with a single host restart.
  async function switchAccount(accountId) {
    try {
      let changed = false;
      if (currentProvider !== OPENAI_PROVIDER) {
        changed = writeProvider(OPENAI_PROVIDER);
        currentProvider = OPENAI_PROVIDER;
        await updateSidebarProvider(BrowserWindow, OPENAI_PROVIDER);
      }
      if (writeAccount(accountId)) {
        changed = true;
      }
      if (!changed) {
        return;
      }
      currentAccountId = accountId;
      accountOptions = storedAccounts();
      await updateSidebarAccount(BrowserWindow, accountId);
      refreshModMenu();
      budgetStatus.refresh();
      const restarted = await restartCodexHost(BrowserWindow);
      if (!restarted || !(await reloadCodexWindows(BrowserWindow))) {
        relaunchApplication(app);
      }
    } catch (error) {
      dialog.showErrorBox(
        "Could not switch Codex account",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // Signing out through auth.json removal is how the CLI's own logout works;
  // the fresh login is then captured by the account-store sync.
  async function addAccount() {
    try {
      if (readAuthJson() != null && backUpActiveAccount() == null) {
        dialog.showErrorBox(
          "Could not add a Codex account",
          "The current login is not a ChatGPT account, so signing out would " +
            "lose it. Sign out through Codex itself first.",
        );
        return;
      }
    } catch (error) {
      dialog.showErrorBox(
        "Could not add a Codex account",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    const { response } = await dialog.showMessageBox({
      type: "info",
      message: "Add a ChatGPT account",
      detail:
        "Codex signs out so you can log in with the account to add. It is " +
        "captured automatically after login, and the current account stays " +
        "available in the menu.",
      buttons: ["Sign Out", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) {
      return;
    }
    try {
      // The login prompt only appears under the built-in provider, so the
      // sign-out lands there like an account switch does.
      if (currentProvider !== OPENAI_PROVIDER) {
        writeProvider(OPENAI_PROVIDER);
        currentProvider = OPENAI_PROVIDER;
        await updateSidebarProvider(BrowserWindow, OPENAI_PROVIDER);
      }
      backUpActiveAccount();
      accountOptions = storedAccounts();
      fs.rmSync(authFilePath(), { force: true });
      currentAccountId = null;
      await updateSidebarAccount(BrowserWindow, null);
      refreshModMenu();
      const restarted = await restartCodexHost(BrowserWindow);
      if (!restarted || !(await reloadCodexWindows(BrowserWindow))) {
        relaunchApplication(app);
      }
    } catch (error) {
      dialog.showErrorBox(
        "Could not add a Codex account",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  globalThis.__codexProfileSwitch = switchProvider;
  globalThis.__codexAccountSwitch = switchAccount;
  globalThis.__codexAccountAdd = addAccount;
  const refreshModMenu = installUpdateMenu(app, dialog, {
    accounts: () => accountOptions,
    activeAccountId: () =>
      currentProvider === OPENAI_PROVIDER ? currentAccountId : null,
    providers: () => providerOptions,
    activeProvider: () => currentProvider,
    switchAccount,
    switchProvider,
    addAccount,
  });
  const budgetStatus = installBudgetStatus(app, BrowserWindow);
  installSidebarSwitcher(
    app,
    BrowserWindow,
    () => currentProvider,
    () => providerOptions,
    switchProvider,
    () => currentAccountId,
    () => accountOptions,
    switchAccount,
    addAccount,
  );
  app.whenReady().then(() => {
    setInterval(() => {
      const before = JSON.stringify([currentAccountId, accountOptions]);
      syncAccountStore();
      if (JSON.stringify([currentAccountId, accountOptions]) !== before) {
        broadcastSidebar();
        refreshModMenu();
      }
    }, AUTH_SYNC_INTERVAL_MS);
  });
}

module.exports = {
  accountFromAuthJson,
  activeProvider,
  backUpActiveAccount,
  configuredProviders,
  install,
  reloadCodexWindows,
  restartCodexHost,
  rewriteModelProvider,
  storedAccounts,
  writeAccount,
};
