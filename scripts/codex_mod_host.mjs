#!/usr/bin/env node
// Runs the Codex mod from outside the application. Codex is launched with
// Chromium's remote debugging switch; this host attaches over the DevTools
// protocol, serves the patched renderer bundles in place of the originals,
// injects the sidebar controls, and performs the account and provider
// switching that used to run inside Codex's main process. The installed
// bundle and its code signature stay untouched.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  activateRelease,
  cliWrapperScript,
  currentCli,
  currentOfficeBridge,
  probeOfficeBridge,
  currentReleaseVersion,
  codexAppVersion,
  downloadRelease,
  fetchLatestRelease,
  INSTALL_ROOT,
  installMode,
  lostPatches,
  migrateCheckoutInstall,
  newerRelease,
  parseVersion,
  newestDownloadedRelease,
  pruneReleases,
  releaseDirectory,
  RELEASES_URL,
  removeRetiredCheckout,
  SOURCE_ROOT,
  sourceRelease,
  supportsCodex,
} from "./installation.mjs";

if (typeof WebSocket !== "function") {
  console.error("codex-mod-host needs Node.js 22 or newer");
  process.exit(1);
}

const require = createRequire(import.meta.url);
const mod = require("./profile_switcher.cjs");
const { repairRollouts } = require("./rollout_repair.cjs");

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CODEX_MOD_CDP_PORT || 48123);
// Read before the login shell's variables are merged in, so a migration
// writes the agent's own Codex home into the new agent.
const AGENT_CODEX_HOME = process.env.CODEX_HOME ?? null;
const INSTALL_MODE = installMode();
// A check fetches only the small release description; downloads and trials
// happen once per release.
const UPDATE_CHECK_INTERVAL_MS = 60 * 1000;
const ATTACH_CHECK_INTERVAL_MS = 30 * 1000;
const LIVENESS_PROBE_TIMEOUT_MS = 3000;
const PAGE_LOAD_TIMEOUT_MS = 30 * 1000;
// While Codex runs, an installed update waits for the user to apply it from
// the window or to quit Codex; the host checks this often whether a window is
// still there to ask.
const APPLY_POLL_INTERVAL_MS = 5000;
// Long enough to read "Updating Codex Mod" before the window reloads.
const UPDATE_PILL_MS = 1500;
const CODEX_APPLIED_PILL_MS = 2600;
// How long a window that opens while the cache is rebuilt for a new Codex
// build waits for it, so it loads patched instead of stock and a reload.
const CODEX_REBUILD_HOLD_MS = 10 * 1000;
const ASAR_POLL_INTERVAL_MS = 2000;
// The newest release the user was told about in the Codex window.
const ANNOUNCED_RELEASE_FILE = path.join(INSTALL_ROOT, "announced-release");
// The Codex build the user last closed the notice about an incompatible
// release for; the notice comes once per build.
const INCOMPATIBLE_NOTICE_FILE = path.join(INSTALL_ROOT, "incompatible-notice");
// Each release that was tried on the installed Codex keeps the verdict next
// to its sources, per Codex build and running release.
const TRIAL_FILE = "trial.json";
const PAGE_LOADED_SCRIPT = `document.readyState === "complete" ||
  new Promise((resolve) => addEventListener("load", () => setTimeout(() => resolve(true)), { once: true }))`;
const BUNDLE = ["/Applications/ChatGPT.app", "/Applications/Codex.app"].find((candidate) =>
  fs.existsSync(candidate),
);
if (BUNDLE == null) {
  console.error("codex-mod-host found no Codex application under /Applications");
  process.exit(1);
}
const ASAR = path.join(BUNDLE, "Contents/Resources/app.asar");
const BUNDLED_CLI = path.join(BUNDLE, "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
const CACHE_DIR = path.join(mod.codexHome(), ".codex-mod-renderer-cache");
const MOD_CONFIG_PATH = path.join(mod.codexHome(), ".codex-mod-config.json");
const CLI_WRAPPER = path.join(mod.codexHome(), ".codex-mod-cli", "codex");
const WATCHER = path.join(SOURCE_ROOT, "build/launch-watcher");
// The patched chunks are cached under their path below the renderer root,
// the path the window requests them by.
const RENDERER_URL_PREFIX = "app://-/";
const MAIN_PAGE_URL = `${RENDERER_URL_PREFIX}index.html`;

const log = (...parts) =>
  console.log(new Date().toISOString().slice(11, 23), "[codex-mod-host]", ...parts);

// The release whose sources this process loaded. The renderer cache can be
// rebuilt from a newer release while this process keeps running, so the
// cache's manifest does not say which injected scripts are live.
const LOADED_RELEASE = sourceRelease().version;

// A full rebuild takes well over a minute even on an idle machine and longer
// while Codex is busy; a tighter limit killed every update build.
const RENDERER_CACHE_TIMEOUT_MS = 10 * 60 * 1000;
const SHELL_ENVIRONMENT_RETRY_MS = 60000;

// The cache is built by the release the agent starts next, which after an
// update is newer than the sources this process runs.
function runCli(args, timeoutMs, cli = currentCli()) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs)
      : null;
    child.on("error", (error) => resolve({ status: null, stdout, stderr: String(error) }));
    child.on("close", (status) => {
      clearTimeout(timer);
      // A killed patcher leaves no output of its own to explain the failure.
      const reason = timedOut ? `cache build timed out after ${timeoutMs / 1000} s` : "";
      resolve({ status, stdout, stderr: stderr || reason });
    });
  });
}

// Electron's integrity check compares the hash of the archive header, so the
// header hash also identifies the Codex build a cache was patched from.
function asarHeaderSha256(asar) {
  const handle = fs.openSync(asar, "r");
  try {
    const sizes = Buffer.alloc(8);
    fs.readSync(handle, sizes, 0, 8, 0);
    const pickleSize = sizes.readUInt32LE(4);
    const pickle = Buffer.alloc(pickleSize);
    fs.readSync(handle, pickle, 0, pickleSize, 8);
    const headerLength = pickle.readUInt32LE(4);
    return createHash("sha256").update(pickle.subarray(8, 8 + headerLength)).digest("hex");
  } finally {
    fs.closeSync(handle);
  }
}

class RendererCache {
  static load() {
    const manifest = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, "manifest.json"), "utf8"));
    const files = new Map(
      manifest.files.map((name) => [name, fs.readFileSync(path.join(CACHE_DIR, name))]),
    );
    return new RendererCache(manifest, files);
  }

  constructor(manifest, files) {
    this.manifest = manifest;
    this.files = files;
  }

  matchesInstalledCodex() {
    try {
      return asarHeaderSha256(ASAR) === this.manifest.asar_header_sha256;
    } catch {
      return false;
    }
  }
}

// The sources of everything the host injects into a page, read once since
// this process keeps running the versions it loaded.
const SOURCES_SHA256 = createHash("sha256")
  .update(fs.readFileSync(path.join(SCRIPT_DIR, "profile_switcher.cjs")))
  .update(fs.readFileSync(fileURLToPath(import.meta.url)))
  .digest("hex");

let rendererCache = null;

// Identifies what a page rendered into now runs: the served bundles and the
// injected controls. A page stamped with another build is reloaded on attach.
function pageBuild() {
  return createHash("sha256")
    .update(SOURCES_SHA256)
    .update(JSON.stringify(rendererCache?.manifest ?? null))
    .digest("hex");
}
let cacheBuild = null;
// The translated labels of the buttons the controls attach to, collected by
// the patcher from Codex's locale catalogs before it patches anything, so
// they are available even when the patches do not match the installed build.
let anchorLabels = {};

function loadAnchorLabels() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, "anchor-labels.json"), "utf8"));
    return data.labels ?? {};
  } catch {
    return {};
  }
}

// Codex's own icon for a custom provider, which the patcher takes from the
// installed build; without it the switcher draws its own.
let providerIcon = null;

function loadProviderIcon() {
  try {
    const body = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, "provider-icon.json"), "utf8")).body;
    return typeof body === "string" ? body : null;
  } catch {
    return null;
  }
}

// The patcher reuses a cache built from the installed Codex build and the
// current sources, so a rebuild only costs time when either changed.
function refreshRendererCache() {
  if (cacheBuild == null) {
    cacheBuild = (async () => {
      const result = await runCli(
        ["build-cache", "--asar", ASAR, "--renderer-cache", CACHE_DIR],
        RENDERER_CACHE_TIMEOUT_MS,
      );
      anchorLabels = loadAnchorLabels();
      providerIcon = loadProviderIcon();
      if (result.status !== 0) {
        throw new Error(`renderer cache build failed: ${result.stderr || result.stdout}`.trim());
      }
      rendererCache = RendererCache.load();
      log(
        `serving ${rendererCache.files.size} patched bundle(s) for ` +
          (rendererCache.manifest.describe || rendererCache.manifest.version),
      );
      return rendererCache;
    })().finally(() => {
      cacheBuild = null;
    });
  }
  return cacheBuild;
}

async function ensureRendererCache() {
  for (;;) {
    try {
      return await refreshRendererCache();
    } catch (error) {
      log(`${error.message}; retrying in 30 s`);
      await sleep(30000);
    }
  }
}

// The rebuild for a Codex build the cache was not patched from, shared by
// everything that notices the change; null while none runs.
let codexRebuild = null;

// A newer release waiting for a Codex update is tried on the new build once
// the running release patched it, which is the baseline it has to match.
function rebuildForCodexUpdate(reason) {
  if (codexRebuild == null) {
    log(`Codex changed since the cache was built (${reason}); rebuilding`);
    codexRebuild = refreshRendererCache().finally(() => {
      codexRebuild = null;
      void checkForUpdate();
    });
  }
  return codexRebuild;
}

function asarSignature() {
  try {
    const stat = fs.statSync(ASAR);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

// Sparkle replaces the bundle only after Codex quits, after the host that
// restarts on the quit has already built its cache from the old build. The
// cache is rebuilt as soon as the new bundle is in place, so the next launch
// loads patched right away. A bundle replaced under a running Codex is left
// to the check on attach, since the running windows still use the old build.
function watchCodexBundle() {
  let checked = null;
  setInterval(() => {
    const signature = asarSignature();
    if (signature == null || signature === checked || cacheBuild != null || rendererCache == null) {
      return;
    }
    checked = signature;
    if (codexPids().length === 0 && !rendererCache.matchesInstalledCodex()) {
      if (switchToDownloadedRelease("Codex was updated")) {
        return;
      }
      rebuildForCodexUpdate("bundle replaced while Codex was not running").catch((error) => log(error.message));
    }
  }, ASAR_POLL_INTERVAL_MS);
}

// The summary line of the release this process runs, from its tag message.
function releaseSummary() {
  try {
    return fs.readFileSync(path.join(SOURCE_ROOT, "SUMMARY"), "utf8").split("\n")[0].trim();
  } catch {
    return "";
  }
}

function writeAnnouncedRelease(version) {
  try {
    fs.mkdirSync(path.dirname(ANNOUNCED_RELEASE_FILE), { recursive: true });
    fs.writeFileSync(ANNOUNCED_RELEASE_FILE, `${version}\n`);
  } catch (error) {
    log(`could not record the announced release: ${error.message}`);
  }
}

// The release to announce in the Codex window: the one this process runs,
// when it is newer than the last one announced. A first install has nothing
// to announce and only records its release.
function pendingReleaseNotice() {
  if (INSTALL_MODE !== "release" || parseVersion(LOADED_RELEASE) == null) {
    return null;
  }
  let announced = null;
  try {
    announced = fs.readFileSync(ANNOUNCED_RELEASE_FILE, "utf8").trim();
  } catch {
    // Nothing announced yet.
  }
  if (announced != null && newerRelease(LOADED_RELEASE, announced)) {
    return { version: LOADED_RELEASE, summary: releaseSummary() };
  }
  if (announced !== LOADED_RELEASE) {
    writeAnnouncedRelease(LOADED_RELEASE);
  }
  return null;
}

function openReleaseNotes(version) {
  if (parseVersion(version) == null) {
    return;
  }
  spawn("/usr/bin/open", [`${RELEASES_URL}/tag/${version}`], { stdio: "ignore" }).on("error", (error) =>
    log(`could not open the release notes: ${error.message}`),
  );
}

// Dialogs are AppleScript alerts carrying the application icon, so they look
// like the ones Codex itself shows. Resolves to the index of the pressed
// button; closing the dialog counts as the cancel button.
const dialogs = new Set();

// Dialogs appear inside the Codex window when one is attached, styled like
// the app's own; the native AppleScript dialog remains for the times Codex is
// not running or not reachable. Resolves to the index of the pressed button.
const MODAL_TIMEOUT_MS = 60 * 60 * 1000;
// Shown for a profile whose provider offers no usage or budget endpoint.
const NO_USAGE_NOTICE = "No usage data for this profile";
const NO_LIMIT_NOTICE = "Unlimited";
let modState = null;

// Every dialog is the in-page modal of the main Codex window. A native
// dialog only stands in while no Codex window is attached; a window that
// cannot answer counts as cancel, so the native dialog never appears next
// to a running Codex.
async function showMessageBox(options) {
  const cancel = () => options.cancelId ?? options.defaultId ?? 0;
  const session = modState?.session;
  const sessionId = session?.mainPageSessionId();
  if (sessionId == null) {
    return showNativeMessageBox(options);
  }
  const answer = await session.prompt(
    sessionId,
    mod.modalPromptScript(options),
    MODAL_TIMEOUT_MS,
  );
  if (answer === "timeout") {
    await session.evaluate(sessionId, "globalThis.__codexDismissModals?.()");
    return cancel();
  }
  if (typeof answer === "number") {
    return answer;
  }
  log(`the Codex window did not answer the dialog "${options.message}" (${JSON.stringify(answer)})`);
  return cancel();
}

function showNativeMessageBox({ message, detail = "", buttons = ["OK"], defaultId = 0, cancelId = null }) {
  const icon = path.join(BUNDLE, "Contents/Resources/electron.icns");
  const list = `{${buttons.map((title) => JSON.stringify(title)).join(", ")}}`;
  const script = [
    `set iconFile to POSIX file ${JSON.stringify(icon)} as alias`,
    `display dialog ${JSON.stringify(detail)} with title ${JSON.stringify(message)} ` +
      `buttons ${list} default button ${defaultId + 1}` +
      (cancelId == null ? "" : ` cancel button ${cancelId + 1}`) +
      " with icon iconFile",
  ];
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/osascript", script.flatMap((line) => ["-e", line]));
    dialogs.add(child);
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.on("close", () => {
      dialogs.delete(child);
      const pressed = /button returned:(.*)$/m.exec(output)?.[1]?.trim();
      const index = buttons.indexOf(pressed);
      resolve(index >= 0 ? index : cancelId ?? 0);
    });
    child.on("error", () => {
      dialogs.delete(child);
      resolve(cancelId ?? 0);
    });
  });
}

function showErrorBox(title, content) {
  return showMessageBox({ message: title, detail: content, buttons: ["OK"] });
}

// Matched at the start of the command line: a process that merely names the
// executable among its arguments, such as a grep for it, is no Codex.
function codexPids() {
  const executable = path.join(BUNDLE, "Contents/MacOS/").replace(/[.]/g, "\\.");
  const result = spawnSync("/usr/bin/pgrep", ["-f", `^${executable}`], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.split(/\s+/).filter(Boolean).map(Number) : [];
}

function processArguments(pid) {
  return spawnSync("/bin/ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }).stdout;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function flaggedCodexRunning() {
  return codexPids().some((pid) => processArguments(pid).includes("--remote-debugging-port="));
}

function readModConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MOD_CONFIG_PATH, "utf8"));
    return typeof parsed === "object" && parsed != null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function updateModConfig(change) {
  const config = readModConfig();
  change(config);
  fs.writeFileSync(MOD_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function browserLoginEnabled() {
  return readModConfig().browserToolsUseChatGPTLogin === true;
}

function setBrowserLoginEnabled(enabled) {
  updateModConfig((config) => {
    if (enabled) {
      config.browserToolsUseChatGPTLogin = true;
    } else {
      delete config.browserToolsUseChatGPTLogin;
    }
  });
}

function officeBridgeEnabled() {
  return readModConfig().officeAccountBridge === true;
}

function setOfficeBridgeEnabled(enabled) {
  updateModConfig((config) => {
    if (enabled) {
      config.officeAccountBridge = true;
    } else {
      delete config.officeAccountBridge;
    }
  });
}

// While a setting needs it, Codex is launched with CODEX_CLI_PATH pointing to
// a wrapper of its bundled CLI. Codex starts its own app-server through it and
// hands the path on to node_repl, which starts the browser tools' app-server;
// the wrapper adds the options the settings ask for (see cliWrapperScript).
// Codex reads it at every app-server start, so a rewrite reaches the next one,
// and it is only removed when Codex launches without it.
function cliWrapperNeeded() {
  return browserLoginEnabled() || officeBridgeEnabled();
}

// Why the Office bridge did not start the last time the wrapper was written,
// or null; the settings page shows it.
let officeBridgeProblem = null;

// The bridge for the wrapper, if the setting is on and the bridge answers.
// The wrapper hides the connector's own tools behind it, so a bridge that
// cannot start would otherwise leave Codex without document tools.
function answeringOfficeBridge() {
  if (!officeBridgeEnabled()) {
    officeBridgeProblem = null;
    return null;
  }
  const bridge = { node: process.execPath, script: currentOfficeBridge(), codexHome: mod.codexHome() };
  const problem = probeOfficeBridge(bridge);
  if (problem !== officeBridgeProblem) {
    log(
      problem == null
        ? "the Office bridge answers"
        : `the Office bridge does not start (${problem}); Codex keeps its own document tools`,
    );
  }
  officeBridgeProblem = problem;
  return problem == null ? bridge : null;
}

function writeCliWrapper() {
  if (!fs.existsSync(BUNDLED_CLI)) {
    return false;
  }
  const script = cliWrapperScript({
    cli: BUNDLED_CLI,
    browserToolsLogin: browserLoginEnabled(),
    officeBridge: answeringOfficeBridge(),
  });
  fs.mkdirSync(path.dirname(CLI_WRAPPER), { recursive: true });
  let current = null;
  try {
    current = fs.readFileSync(CLI_WRAPPER, "utf8");
  } catch {
    // Not written yet.
  }
  if (current !== script) {
    // Codex may start the wrapper at any moment, so it never sees half a file.
    const temporary = `${CLI_WRAPPER}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, script, { mode: 0o755 });
    fs.renameSync(temporary, CLI_WRAPPER);
  }
  fs.chmodSync(CLI_WRAPPER, 0o755);
  return true;
}

function cliLaunchEnvironment() {
  if (!cliWrapperNeeded()) {
    fs.rmSync(path.dirname(CLI_WRAPPER), { recursive: true, force: true });
    return [];
  }
  if (!writeCliWrapper()) {
    log(`bundled Codex CLI missing (${BUNDLED_CLI}); Codex starts without the CLI wrapper`);
    return [];
  }
  return ["--env", `CODEX_CLI_PATH=${CLI_WRAPPER}`];
}

// Codex reads its logins and state from CODEX_HOME. A Codex the host launches
// shares the home the host was installed for, so a separate home keeps its
// logins apart from the Codex CLI's.
function codexHomeLaunchEnvironment() {
  return process.env.CODEX_HOME ? ["--env", `CODEX_HOME=${mod.codexHome()}`] : [];
}

// LaunchServices refuses a launch while it still considers the process just
// killed to be starting, so the request is repeated until a flagged process
// exists.
async function launchCodex() {
  const environment = [...codexHomeLaunchEnvironment(), ...cliLaunchEnvironment()];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = spawnSync("/usr/bin/open", [...environment, BUNDLE, "--args", `--remote-debugging-port=${PORT}`], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      log(`open failed (${result.status}): ${result.stderr.trim()}`);
    }
    await sleep(250);
    if (flaggedCodexRunning()) {
      return true;
    }
  }
  log("giving up on launching Codex");
  return false;
}

// Set while the host swaps Codex itself, which is not a quit to restart on.
// The count tells a connection that ends after the swap already finished,
// which happens since a helper holds on to the socket for a moment.
let relaunchingCodex = false;
let codexSwaps = 0;

async function relaunchCodex() {
  relaunchingCodex = true;
  codexSwaps += 1;
  try {
    await swapCodex();
  } finally {
    relaunchingCodex = false;
  }
}

async function swapCodex() {
  for (const pid of codexPids()) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      continue;
    }
  }
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && codexPids().length > 0) {
    await sleep(250);
  }
  await launchCodex();
}

// Dock launches carry no switches, so the watcher reports them early enough
// to swap the process for a flagged one before its window appears.
let watcher = null;

function startLaunchWatcher() {
  if (!fs.existsSync(WATCHER)) {
    log(`launch watcher missing (${WATCHER}); Dock launches run without the mod`);
    return;
  }
  const child = spawn(WATCHER, ["com.openai.codex"], { stdio: ["ignore", "pipe", "inherit"] });
  watcher = child;
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const [event, pid, state] = line.split(" ");
    if (event !== "launch") {
      return;
    }
    if (state === "unflagged") {
      log(`relaunching unflagged Codex ${pid} with the debugging switch`);
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        return;
      }
      void launchCodex();
    } else {
      log(`Codex ${pid} launched with the debugging switch`);
    }
  });
  child.on("exit", (code) => {
    if (watcher !== child) {
      return;
    }
    log(`launch watcher exited (${code}); restarting`);
    setTimeout(startLaunchWatcher, 1000);
  });
}

// Removes the mod on request from the settings page, which has already asked
// the user to confirm. The uninstall boots this very host out of launchd, so
// it runs detached and finishes on its own: after the host is gone it starts
// Codex again without the debugging switch.
let uninstalling = false;

async function uninstallMod() {
  if (uninstalling) {
    return;
  }
  uninstalling = true;
  try {
    log("uninstalling on request from the settings page");
    // The watcher would relaunch the stock Codex with the switch again.
    const child = watcher;
    watcher = null;
    child?.kill("SIGTERM");
    for (const pid of codexPids()) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        continue;
      }
    }
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && codexPids().length > 0) {
      await sleep(250);
    }
    const script =
      `${JSON.stringify(process.execPath)} ${JSON.stringify(currentCli())} uninstall ` +
      `--asar ${JSON.stringify(ASAR)} --renderer-cache ${JSON.stringify(CACHE_DIR)}; ` +
      `/usr/bin/open ${codexHomeLaunchEnvironment().map((part) => JSON.stringify(part)).join(" ")} ${JSON.stringify(BUNDLE)}`;
    spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" }).unref();
  } finally {
    uninstalling = false;
  }
}

// Child processes outlive a killed parent, so a stopped host takes its
// watcher and any open dialog down with it.
function shutdown(signal) {
  const children = [watcher, ...dialogs].filter(Boolean);
  watcher = null;
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      continue;
    }
  }
  process.exit(signal === "SIGINT" ? 130 : 0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// A launch agent starts with launchd's minimal environment, while provider
// keys live in the user's shell profile, so the login shell's variables are
// merged in the way Codex itself resolves them.
// Resolves to the number of variables added, or null when the shell failed,
// so the caller can try again instead of running without them for good.
function loadShellEnvironment() {
  const shell = process.env.SHELL || "/bin/zsh";
  return new Promise((resolve) => {
    // Oh My Zsh checks for updates on shell start, which hangs past the
    // timeout without network; this shell only has to print its environment.
    const child = spawn(shell, ["-ilc", "/usr/bin/env -0"], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, DISABLE_AUTO_UPDATE: "true" },
    });
    const chunks = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", () => resolve(null));
    child.on("close", (status) => {
      clearTimeout(timer);
      if (status !== 0) {
        resolve(null);
        return;
      }
      let added = 0;
      for (const entry of Buffer.concat(chunks).toString("utf8").split("\0")) {
        const separator = entry.indexOf("=");
        if (separator <= 0) {
          continue;
        }
        const name = entry.slice(0, separator);
        if (name !== "PATH" && name !== "DISABLE_AUTO_UPDATE" && !(name in process.env)) {
          process.env[name] = entry.slice(separator + 1);
          added += 1;
        }
      }
      resolve(added);
    });
  });
}

class DevToolsClient {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #closed = false;
  #onClose = null;
  handlers = new Set();

  static async connect(port) {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error("DevTools socket failed"));
    });
    return new DevToolsClient(socket);
  }

  constructor(socket) {
    this.#socket = socket;
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id != null && this.#pending.has(message.id)) {
        this.#pending.get(message.id)(message);
        this.#pending.delete(message.id);
        return;
      }
      for (const handler of this.handlers) {
        handler(message);
      }
    };
  }

  onClose(callback) {
    this.#onClose = callback;
    this.#socket.onclose = () => this.close("socket closed");
  }

  // Codex can stop reading a DevTools connection without ever closing it: a
  // helper it spawns inherits the socket, so the kernel keeps the connection
  // established after the browser dropped its end and no close event
  // arrives. The host then ends the connection itself; every pending call
  // fails at once and the close callback runs exactly once.
  close(reason) {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#socket.onmessage = null;
    this.#socket.onclose = null;
    for (const resolve of this.#pending.values()) {
      resolve({ error: { message: `connection closed: ${reason}` } });
    }
    this.#pending.clear();
    try {
      this.#socket.close();
    } catch {
      // The socket may already be gone.
    }
    this.#onClose?.();
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve) => {
      if (this.#closed) {
        resolve({ error: { message: "connection closed" } });
        return;
      }
      const id = this.#nextId++;
      this.#pending.set(id, resolve);
      try {
        this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
      } catch (error) {
        this.#pending.delete(id);
        resolve({ error: { message: error.message } });
      }
    });
  }

  async call(method, params, sessionId, timeoutMs = 5000) {
    const response = await Promise.race([
      this.send(method, params, sessionId),
      sleep(timeoutMs).then(() => ({ error: { message: `${method} timed out` } })),
    ]);
    if (response.error) {
      throw new Error(response.error.message);
    }
    return response.result;
  }
}

class ModSession {
  pages = new Map();
  #client;
  #state;
  #attachCheck = null;
  #attaching = false;

  constructor(client, state) {
    this.#client = client;
    this.#state = state;
  }

  async start() {
    const client = this.#client;
    client.handlers.add((message) => {
      this.#handleEvent(message).catch((error) => log(`event handling failed: ${error.message}`));
    });
    await client.call("Target.setDiscoverTargets", { discover: true });
    await client.call("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    await this.attachUnattachedPages();
    this.#attachCheck = setInterval(
      () => void this.attachUnattachedPages(),
      ATTACH_CHECK_INTERVAL_MS,
    );
  }

  stop() {
    clearInterval(this.#attachCheck);
    this.#attachCheck = null;
  }

  // Codex can drop a page session while the browser connection stays open,
  // as seen across a lid-close sleep; auto-attach only covers new targets,
  // so existing pages are checked and re-attached explicitly. The same check
  // doubles as the connection's heartbeat: see #connectionDied.
  async attachUnattachedPages() {
    if (this.#attaching) {
      return;
    }
    this.#attaching = true;
    try {
      const targetInfos = await this.#listTargets();
      if (targetInfos == null) {
        return;
      }
      for (const target of targetInfos) {
        if (target.type !== "page" || target.attached) {
          continue;
        }
        if (target.url.startsWith("app://")) {
          log(`page session lost: ${target.url}; re-attaching`);
        }
        await this.#client.call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      }
    } catch (error) {
      log(`attach check failed: ${error.message}`);
    } finally {
      this.#attaching = false;
    }
  }

  // Lists the targets, or null once the connection was found dead and ended.
  // A single timeout is not proof: a call made just before the machine slept
  // times out on wake although the connection is fine, so the call is
  // repeated before the browser is asked over a fresh HTTP request.
  async #listTargets() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { targetInfos } = await this.#client.call("Target.getTargets");
        return targetInfos;
      } catch (error) {
        if (!/timed out/.test(error.message)) {
          throw error;
        }
      }
    }
    if (await devToolsReachable(LIVENESS_PROBE_TIMEOUT_MS)) {
      this.#connectionDied("Codex answers a fresh connection but not this one");
      return null;
    }
    throw new Error("Target.getTargets timed out and Codex does not answer HTTP either");
  }

  // Codex hands its DevTools socket down to a helper it spawns, so when the
  // browser drops the connection (seen after a lid-close sleep) the helper's
  // copy keeps it established: no close arrives, every command queues up
  // unanswered, and the page sessions are gone. The only way back is a new
  // connection, so this one is ended and main() reconnects.
  #connectionDied(reason) {
    log(`DevTools connection is dead (${reason}); reconnecting`);
    this.#client.close(reason);
  }

  async #handleEvent(message) {
    const { method, params, sessionId } = message;
    if (method === "Target.attachedToTarget") {
      await this.#attached(params);
    } else if (method === "Target.targetInfoChanged") {
      // A page is attached before it navigates, so its URL is only known
      // once it has loaded; the main window is told apart by it.
      for (const page of this.pages.values()) {
        if (page.targetId === params.targetInfo.targetId) {
          page.url = params.targetInfo.url;
        }
      }
    } else if (method === "Target.detachedFromTarget") {
      const page = this.pages.get(params.sessionId);
      this.pages.delete(params.sessionId);
      if (page != null) {
        log(`page session detached: ${page.url}`);
        await this.attachUnattachedPages();
      }
    } else if (method === "Fetch.requestPaused") {
      await this.#serve(sessionId, params);
    } else if (method === "Page.loadEventFired") {
      await this.#pageLoaded(sessionId);
    } else if (method === "Runtime.consoleAPICalled") {
      // Enabling the runtime replays the page's console history, which would
      // re-run every bridge request made before this attach.
      const attachedAt = this.pages.get(sessionId)?.attachedAt ?? Infinity;
      const text = params.args?.[0]?.value;
      if (typeof text === "string" && params.timestamp >= attachedAt) {
        this.#state.handleConsoleMessage(text);
      }
    }
  }

  async #attached({ sessionId, targetInfo, waitingForDebugger }) {
    const client = this.#client;
    if (targetInfo.type !== "page") {
      if (waitingForDebugger) {
        await client.call("Runtime.runIfWaitingForDebugger", {}, sessionId);
      }
      return;
    }
    this.pages.set(sessionId, {
      targetId: targetInfo.targetId,
      url: targetInfo.url,
      attachedAt: Date.now(),
    });
    if (rendererCache != null && !rendererCache.matchesInstalledCodex()) {
      // Codex updated itself; the stale bundles no longer match the new file
      // names. A window that has not loaded yet waits for the rebuild; one
      // that loads or loaded stock is reloaded once the rebuild is done.
      if (switchToDownloadedRelease("Codex was updated")) {
        return;
      }
      const rebuild = rebuildForCodexUpdate("a window opened");
      const rebuilt =
        waitingForDebugger &&
        (await Promise.race([
          rebuild.then(
            () => true,
            () => true,
          ),
          sleep(CODEX_REBUILD_HOLD_MS).then(() => false),
        ]));
      if (!rebuilt) {
        this.#reloadAfterRebuild(rebuild, sessionId);
      }
    }
    await this.#interceptAssets(sessionId);
    // A paused target answers the document script registration only once it
    // runs, so the registration is awaited after the resume. Commands needing
    // a JavaScript context block while the target is paused, so nothing but
    // Fetch and the document script is configured before the page resumes.
    const documentScript = this.#registerDocumentScript(sessionId, this.#state.documentScript());
    if (waitingForDebugger) {
      await client.call("Runtime.runIfWaitingForDebugger", {}, sessionId);
    }
    await documentScript;
    await client.call("Page.enable", {}, sessionId);
    await client.call("Runtime.enable", {}, sessionId);
    await client.call("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);
    if (waitingForDebugger || !targetInfo.url.startsWith("app://")) {
      void this.#renderWhenLoaded(sessionId);
      return;
    }
    // A page rendered into by a host of the same build still runs these
    // patched bundles and controllers, whichever connection or process
    // served them; only the injected controls need the current state again.
    // Any other page runs the stock bundles or an earlier build's.
    if ((await this.evaluate(sessionId, mod.modPresentScript(pageBuild()))) === true) {
      log("re-attached to page:", targetInfo.url);
      await this.#state.renderInto(this, sessionId);
      if (sessionId === this.mainPageSessionId()) {
        await this.#state.showNotices(this, sessionId);
      }
    } else {
      log("reloading page that loaded before attach or runs another build:", targetInfo.url);
      // Codex treats an aborted first load as a failed start and blocks on a
      // native alert, so a page still loading finishes before it reloads.
      await this.prompt(sessionId, PAGE_LOADED_SCRIPT, PAGE_LOAD_TIMEOUT_MS);
      await this.reloadPage(sessionId);
    }
  }

  // A window that was paused, or had no document yet, loads the bundles
  // through this interception. Neither its load event nor the document
  // script is sure to reach its first document: the event may fire before the
  // page domain is enabled, and a target may run the document before it
  // processes the registration. So the window is watched until it shows a
  // loaded app page, which gets the controls if it lacks them.
  async #renderWhenLoaded(sessionId) {
    const deadline = Date.now() + PAGE_LOAD_TIMEOUT_MS;
    const probe = `[location.href, document.readyState, globalThis.__codexModBundles === true, ${mod.modPresentScript(pageBuild())}]`;
    while (this.pages.has(sessionId) && Date.now() < deadline) {
      const [url, readyState, patched, rendered] = (await this.evaluate(sessionId, probe)) ?? [];
      if (readyState === "complete" && typeof url === "string" && url !== "about:blank") {
        if (!url.startsWith("app://") || rendered) {
          return;
        }
        if (patched) {
          await this.#pageLoaded(sessionId);
        }
        return;
      }
      await sleep(250);
    }
  }

  // Windows that load stock while the cache is rebuilt for a new Codex build
  // reload together once it is; the main window shows the progress through
  // showNotices meanwhile.
  #staleSessions = new Set();

  #reloadAfterRebuild(rebuild, sessionId) {
    const first = this.#staleSessions.size === 0;
    this.#staleSessions.add(sessionId);
    if (!first) {
      return;
    }
    rebuild
      .then(async () => {
        const sessionIds = [...this.#staleSessions].filter((id) => this.pages.has(id));
        this.#staleSessions.clear();
        this.#state.codexReapplied = true;
        await this.#reloadPagesWithCurrentCache(sessionIds);
      })
      .catch((error) => {
        this.#staleSessions.clear();
        log(error.message);
        void this.broadcast(mod.clearPillsScript());
      });
  }

  // Registers the cached bundle names with the page's request interception.
  // Calling it again replaces the earlier patterns, which a page needs once a
  // rebuilt cache carries different file names.
  async #interceptAssets(sessionId) {
    const patterns = [...rendererCache.files.keys()].map((name) => ({
      urlPattern: `${RENDERER_URL_PREFIX}${name}`,
      requestStage: "Request",
    }));
    if (patterns.length > 0) {
      await this.#client.call("Fetch.enable", { patterns }, sessionId);
    }
  }

  // A page attached while the cache was stale intercepts the old bundle
  // names; a reload alone would load stock again.
  async #reloadPagesWithCurrentCache(sessionIds) {
    for (const sessionId of sessionIds) {
      try {
        await this.#interceptAssets(sessionId);
      } catch (error) {
        log(`could not update interception for a page: ${error.message}`);
      }
    }
    await this.reloadPages(sessionIds);
  }

  async #serve(sessionId, { requestId, request }) {
    const name = new URL(request.url).pathname.replace(/^\/+/, "");
    const body = rendererCache.files.get(name);
    if (body == null) {
      await this.#client.call("Fetch.continueRequest", { requestId }, sessionId);
      return;
    }
    await this.#client.call(
      "Fetch.fulfillRequest",
      {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "text/javascript" }],
        body: body.toString("base64"),
      },
      sessionId,
      15000,
    );
  }

  async #pageLoaded(sessionId) {
    const page = this.pages.get(sessionId);
    if (page == null) {
      return;
    }
    await this.#state.renderInto(this, sessionId);
    if (page.threadRoute) {
      page.threadRoute = false;
      await this.prompt(sessionId, mod.settleThreadRouteScript(), 15000);
      page.url = MAIN_PAGE_URL;
    }
    if (sessionId === this.mainPageSessionId()) {
      await this.#state.showNotices(this, sessionId);
    }
  }

  evaluate(sessionId, expression, timeoutMs = 5000) {
    return this.#client
      .call("Runtime.evaluate", { expression, returnByValue: true }, sessionId, timeoutMs)
      .then((result) => result.result?.value)
      .catch(() => undefined);
  }

  // Evaluates an expression that yields a promise and waits for it; "timeout"
  // when the wait ran out, undefined when the page could not answer.
  prompt(sessionId, expression, timeoutMs) {
    return this.#client
      .call(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
        timeoutMs,
      )
      .then((result) => result.result?.value)
      .catch((error) => (/timed out/.test(error.message) ? "timeout" : undefined));
  }

  // The window that carries the sidebar; overlays and helper windows are not
  // where a dialog belongs.
  mainPageSessionId() {
    for (const [sessionId, page] of this.pages) {
      if (page.url.startsWith("app://") && !page.url.includes("initialRoute=")) {
        return sessionId;
      }
    }
    return null;
  }

  // The controls run at the start of every document a window loads, with the
  // state of the last change; the load event renders the current state again.
  async setDocumentScript(source) {
    await Promise.allSettled([...this.pages.keys()].map((sessionId) => this.#registerDocumentScript(sessionId, source)));
  }

  // Each registration replaces the previous one, so they run one at a time
  // per page. The first starts at once, so its command goes out before
  // anything the caller sends next.
  #registerDocumentScript(sessionId, source) {
    const page = this.pages.get(sessionId);
    if (page == null) {
      return Promise.resolve();
    }
    const replace = () => this.#replaceDocumentScript(page, sessionId, source);
    const queued = page.documentScriptQueue == null ? replace() : page.documentScriptQueue.then(replace);
    page.documentScriptQueue = queued;
    void queued.finally(() => {
      if (page.documentScriptQueue === queued) {
        page.documentScriptQueue = null;
      }
    });
    return queued;
  }

  async #replaceDocumentScript(page, sessionId, source) {
    if (page.documentScript === source) {
      return;
    }
    try {
      // A window Codex opens to replace another on an account change loses
      // the script registered while it waited for the debugger, which leaves
      // nothing to remove.
      if (page.documentScriptId != null) {
        await this.#client
          .call("Page.removeScriptToEvaluateOnNewDocument", { identifier: page.documentScriptId }, sessionId)
          .catch((error) => {
            if (!/Script not found/.test(error.message)) throw error;
          });
      }
      const { identifier } = await this.#client.call("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId);
      page.documentScriptId = identifier;
      page.documentScript = source;
    } catch (error) {
      if (this.pages.get(sessionId) === page) {
        log(`could not register the document script for ${page.url}: ${error.message}`);
      }
    }
  }

  async broadcast(expression) {
    await Promise.allSettled(
      [...this.pages.keys()].map((sessionId) => this.evaluate(sessionId, expression)),
    );
  }

  // Reloads a window; the main window comes back showing the thread it
  // showed before.
  async reloadPage(sessionId) {
    const page = this.pages.get(sessionId);
    const threadId =
      sessionId === this.mainPageSessionId() ? await this.evaluate(sessionId, mod.activeThreadScript()) : null;
    // The renderer's memory cache never expires app:// responses and survives
    // reloads, so a bundle it loaded stock stays stock even after the
    // interception covers it. Disabling the cache evicts it.
    await this.#client.call("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);
    if (page != null && typeof threadId === "string" && /^[\w-]+$/.test(threadId)) {
      page.threadRoute = true;
      await this.#client.call("Page.navigate", { url: mod.threadRouteUrl(threadId) }, sessionId);
    } else {
      await this.#client.call("Page.reload", {}, sessionId);
    }
  }

  async reloadPages(sessionIds = [...this.pages.keys()]) {
    await sleep(750);
    let reloaded = false;
    for (const sessionId of sessionIds) {
      try {
        await this.reloadPage(sessionId);
        reloaded = true;
      } catch {
        continue;
      }
    }
    return reloaded;
  }
}

// The account and provider state of the mod, independent of any one Codex
// process; a session comes and goes with each Codex run.
class ModState {
  session = null;
  provider = mod.OPENAI_PROVIDER;
  providers = [{ provider: mod.OPENAI_PROVIDER, label: "OpenAI" }];
  // The saved login's person and, for matching usage reports, the
  // workspace that login is signed in to.
  accountId = null;
  workspaceId = null;
  accounts = [];
  budgetPayload = null;
  #usagePayload = null;
  #usageWorkspaceId = null;
  #usageFetchedAt = 0;
  #liveUsageAt = 0;
  #failedUsagePolls = 0;
  #failedBudgetPolls = 0;
  #lastBudgetProvider = null;
  #polling = false;
  #addingAccount = false;
  // Shown once in the main window after the next load.
  #releaseNotice = pendingReleaseNotice();
  codexReapplied = false;

  constructor() {
    this.reloadProviders();
    this.syncAccounts();
  }

  reloadProviders() {
    try {
      const configText = fs.readFileSync(path.join(mod.codexHome(), "config.toml"), "utf8");
      this.provider = mod.activeProvider(configText);
      this.providers = mod.configuredProviders(configText);
    } catch {
      this.provider = mod.OPENAI_PROVIDER;
    }
  }

  // Rereads only the provider list, so a `[model_providers.<id>]` section
  // added while the host runs shows up without a restart. The active provider
  // is left alone: the running app-server still uses the one it started with.
  syncProviders() {
    const before = JSON.stringify(this.providers);
    try {
      const configText = fs.readFileSync(path.join(mod.codexHome(), "config.toml"), "utf8");
      this.providers = mod.configuredProviders(configText);
    } catch {
      return false;
    }
    return JSON.stringify(this.providers) !== before;
  }

  syncAccounts() {
    const before = JSON.stringify([this.accountId, this.accounts]);
    try {
      const previous = this.accountId;
      this.accountId = mod.backUpActiveAccount();
      this.workspaceId = mod.activeAccount()?.workspaceId ?? null;
      if (previous != null && this.accountId == null && !fs.existsSync(mod.authFilePath())) {
        this.#dropSnapshot(previous, "signed out in Codex");
      }
      this.accounts = mod.storedAccounts();
    } catch {
      return false;
    }
    return JSON.stringify([this.accountId, this.accounts]) !== before;
  }

  // Signing out through Codex revokes the session with OpenAI, so the saved
  // login could never sign that account in again. The host's own removals
  // clear `accountId` before the sync sees the file go, so only Codex's
  // sign-out reaches here.
  #dropSnapshot(accountId, reason) {
    const label = this.accounts.find((option) => option.accountId === accountId)?.label ?? accountId;
    mod.removeAccountSnapshot(accountId);
    log(`${label} ${reason}; removed its saved login from the switcher`);
  }

  async #dropRevokedLogin(accountId) {
    this.#dropSnapshot(accountId, "no longer has a valid login");
    fs.rmSync(mod.authFilePath(), { force: true });
    this.accountId = null;
    this.workspaceId = null;
    this.accounts = mod.storedAccounts();
    await this.session?.broadcast("globalThis.__codexSetActiveAccount?.(null)");
    await this.broadcastSidebar();
  }

  sidebarScript() {
    return (
      `${mod.activeProviderSyncScript(this.provider)};` +
      mod.sidebarProfileScript(
        this.provider,
        this.providers,
        this.accountId,
        this.accounts,
        anchorLabels,
        providerIcon,
      )
    );
  }

  settingsScript() {
    const manifest = rendererCache?.manifest;
    const enabled = browserLoginEnabled();
    return mod.settingsSectionScript(
      manifest?.version ?? "unknown",
      manifest?.describe ?? null,
      { available: enabled || this.accountId != null, enabled },
      updateStatus(),
      { enabled: officeBridgeEnabled(), problem: officeBridgeProblem },
    );
  }

  documentScript() {
    return mod.documentStartScript([
      mod.modalScript(),
      mod.noticesScript(),
      this.sidebarScript(),
      mod.threadGuardScript(),
      mod.usageStatusScript(this.budgetPayload, anchorLabels),
      this.settingsScript(),
      mod.markModBuildScript(pageBuild()),
    ]);
  }

  // The controls reach a loaded page in one evaluation, the same as at the
  // start of a document: a window that reloads meanwhile gets all of them or
  // none, and each waits for the new document's body.
  async renderInto(session, sessionId) {
    await session.evaluate(sessionId, this.documentScript());
  }

  // The notices due in a freshly loaded main window: the release this host
  // brought, or how far re-applying the mod to a new Codex build got.
  async showNotices(session, sessionId) {
    if (codexRebuild != null) {
      await session.evaluate(sessionId, mod.pillScript("Codex updated, re-applying Codex Mod", { spinner: true }));
      return;
    }
    if (this.codexReapplied) {
      this.codexReapplied = false;
      await session.evaluate(sessionId, mod.pillScript("Codex Mod applied", { ms: CODEX_APPLIED_PILL_MS }));
    }
    const notice = this.#releaseNotice;
    if (notice != null && (await session.evaluate(sessionId, mod.updateNoticeScript(notice))) === true) {
      this.#releaseNotice = null;
      writeAnnouncedRelease(notice.version);
      log(`announced release ${notice.version} in the Codex window`);
    }
    if (pendingUpdate != null) {
      await session.evaluate(sessionId, mod.readyNoticeScript(pendingUpdate));
    }
    await this.showIncompatibleNotice(session, sessionId);
  }

  async showIncompatibleNotice(session = this.session, sessionId = session?.mainPageSessionId()) {
    if (sessionId == null || !incompatibleNoticeDue()) {
      return;
    }
    const { version, codex, minimum } = blockedRelease;
    await session.evaluate(sessionId, mod.incompatibleNoticeScript({ version, codex, minimum }));
  }

  async broadcastSidebar() {
    await this.session?.broadcast(mod.documentStartScript([this.sidebarScript()]));
    await this.session?.setDocumentScript(this.documentScript());
  }

  async broadcastSettings() {
    await this.session?.broadcast(mod.documentStartScript([this.settingsScript()]));
    await this.session?.setDocumentScript(this.documentScript());
  }

  async broadcastBudget() {
    await this.session?.broadcast(mod.documentStartScript([mod.usageStatusScript(this.budgetPayload, anchorLabels)]));
    await this.session?.setDocumentScript(this.documentScript());
  }

  handleConsoleMessage(text) {
    const prefixes = {
      "__codex_profile_switch__:": (value) =>
        this.providers.some((option) => option.provider === value) && this.switchProvider(value),
      "__codex_account_switch__:": (value) =>
        this.accounts.some((option) => option.accountId === value) && this.switchAccount(value),
      "__codex_account_forget__:": (value) =>
        this.accounts.some((option) => option.accountId === value) && this.forgetAccount(value),
      "__codex_thread_forked__:": (value) => {
        log(`thread forked: ${value}`);
        return true;
      },
      "__codex_browser_login__:": (value) => {
        const [state, when] = value.split(":");
        return (
          (state === "on" || state === "off") &&
          (when === "restart" || when === "later") &&
          this.setBrowserLogin(state === "on", when === "restart")
        );
      },
      "__codex_office_bridge__:": (value) => {
        const [state, when] = value.split(":");
        return (
          (state === "on" || state === "off") &&
          (when === "restart" || when === "later") &&
          this.setOfficeBridge(state === "on", when === "restart")
        );
      },
    };
    if (text === "__codex_account_add__") {
      void this.addAccount();
      return;
    }
    if (text === "__codex_mod_uninstall__") {
      void uninstallMod();
      return;
    }
    if (text === "__codex_mod_update_install__") {
      requestInstall();
      return;
    }
    const automaticUpdatesPrefix = "__codex_mod_automatic_updates__:";
    if (text.startsWith(automaticUpdatesPrefix)) {
      void this.setAutomaticUpdates(text.slice(automaticUpdatesPrefix.length) === "on");
      return;
    }
    const incompatiblePrefix = "__codex_mod_incompatible_dismissed__:";
    if (text.startsWith(incompatiblePrefix)) {
      dismissIncompatibleNotice(text.slice(incompatiblePrefix.length));
      return;
    }
    const releaseNotesPrefix = "__codex_mod_release_notes__:";
    if (text.startsWith(releaseNotesPrefix)) {
      openReleaseNotes(text.slice(releaseNotesPrefix.length));
      return;
    }
    const usagePrefix = "__codex_rate_limits__:";
    if (text.startsWith(usagePrefix)) {
      void this.reportRateLimits(text.slice(usagePrefix.length));
      return;
    }
    for (const [prefix, handler] of Object.entries(prefixes)) {
      if (text.startsWith(prefix)) {
        void handler(text.slice(prefix.length));
        return;
      }
    }
  }

  async setAutomaticUpdates(enabled) {
    try {
      setAutomaticUpdates(enabled);
    } catch (error) {
      await showErrorBox("Could not change the automatic updates setting", String(error?.message ?? error));
      return;
    }
    log(`automatic updates ${enabled ? "on" : "off"}`);
    await this.broadcastSettings();
    if (enabled) {
      void checkForUpdate();
    }
  }

  // The setting takes effect the next time the host launches Codex; the page
  // has already asked whether that should happen now.
  async setBrowserLogin(enabled, restart) {
    try {
      setBrowserLoginEnabled(enabled);
      writeCliWrapper();
    } catch (error) {
      await showErrorBox("Could not change the browser tools setting", String(error?.message ?? error));
      return;
    }
    await this.#applyLaunchSetting(`browser tools ${enabled ? "use" : "no longer use"} the ChatGPT login`, restart);
  }

  async setOfficeBridge(enabled, restart) {
    try {
      setOfficeBridgeEnabled(enabled);
      writeCliWrapper();
    } catch (error) {
      await showErrorBox("Could not change the Office add-ins setting", String(error?.message ?? error));
      return;
    }
    const change = `Office add-ins ${enabled ? "use" : "no longer use"} the account bridge`;
    await this.#applyLaunchSetting(change, restart);
  }

  async #applyLaunchSetting(change, restart) {
    if (restart) {
      log(`${change}; restarting Codex`);
      await relaunchCodex();
      return;
    }
    log(`${change} from the next Codex launch`);
    await this.broadcastSettings();
  }

  async #restartHost() {
    const session = this.session;
    if (session == null) {
      return false;
    }
    for (const sessionId of session.pages.keys()) {
      const restarted = await session.evaluate(
        sessionId,
        "globalThis.__codexProfileRestart ? globalThis.__codexProfileRestart() : false",
      );
      if (restarted === true) {
        return true;
      }
    }
    return false;
  }

  async #showsSignIn() {
    const session = this.session;
    const sessionId = session?.mainPageSessionId();
    if (sessionId == null) {
      return false;
    }
    return (await session.evaluate(sessionId, "globalThis.__codexShowsSignIn?.() === true")) === true;
  }

  // Restarts Codex's host on the new login or profile. A window on the
  // sign-in screen, or headed there because the switch signs out, gets there
  // or leaves it by itself once the restarted app-server answers, as with
  // Codex's own sign-in and sign-out; a reload would race the restart and
  // show Codex's loading screen twice. Any other switch reloads the windows,
  // so they drop what they cached for the previous profile; the main window
  // keeps its thread.
  async #applySwitch({ signsOut = false } = {}) {
    const reload = !signsOut && !(await this.#showsSignIn());
    if (!(await this.#restartHost())) {
      await relaunchCodex();
    } else if (reload && !(await this.session?.reloadPages())) {
      await relaunchCodex();
    }
  }

  async #setProvider(provider) {
    const changed = mod.writeProvider(provider);
    this.provider = provider;
    this.reloadProviders();
    await this.session?.broadcast(
      `${mod.activeProviderSyncScript(provider)};globalThis.__codexSetActiveProfile?.(${JSON.stringify(provider)})`,
    );
    return changed;
  }

  async switchProvider(provider) {
    if (this.switchInProgress) return;
    this.switchInProgress = true;
    try {
      if (!(await this.#setProvider(provider))) {
        return;
      }
      this.refreshBudget();
      await this.#applySwitch();
    } catch (error) {
      await showErrorBox("Could not switch Codex profile", String(error?.message ?? error));
    } finally {
      this.switchInProgress = false;
    }
  }

  async switchAccount(accountId) {
    if (this.switchInProgress) return;
    this.switchInProgress = true;
    try {
      let changed = false;
      if (this.provider !== mod.OPENAI_PROVIDER) {
        changed = await this.#setProvider(mod.OPENAI_PROVIDER);
      }
      if (mod.writeAccount(accountId)) {
        changed = true;
      }
      if (!changed) {
        return;
      }
      this.accountId = accountId;
      this.workspaceId = mod.activeAccount()?.workspaceId ?? null;
      this.accounts = mod.storedAccounts();
      await this.session?.broadcast(
        `globalThis.__codexSetActiveAccount?.(${JSON.stringify(accountId)})`,
      );
      this.refreshBudget();
      // Codex's main process keeps account state of its own. Builds that
      // switch accounts natively drop it and replace their windows once the
      // restarted app-server reports the other account; on any other build
      // only a relaunch drops it, since a reload keeps the main process.
      if (rendererCache?.manifest.patches?.["native account switch"] !== true || !(await this.#restartHost())) {
        await relaunchCodex();
      }
    } catch (error) {
      await showErrorBox("Could not switch Codex account", String(error?.message ?? error));
    } finally {
      this.switchInProgress = false;
    }
  }

  async addAccount() {
    // A second request while the confirmation is open would stack another
    // dialog and run the sign-out twice.
    if (this.#addingAccount) {
      return;
    }
    this.#addingAccount = true;
    try {
      await this.#addAccount();
    } finally {
      this.#addingAccount = false;
    }
  }

  async #addAccount() {
    const response = await showMessageBox({
      message: "Add a ChatGPT account",
      detail:
        "Codex opens the sign-in screen so you can log in with the account to add. " +
        "This stops any running threads.",
      buttons: ["Cancel", "Add"],
      defaultId: 1,
      cancelId: 0,
    });
    if (response !== 1) {
      return;
    }
    try {
      if (this.provider !== mod.OPENAI_PROVIDER) {
        await this.#setProvider(mod.OPENAI_PROVIDER);
      }
      mod.backUpActiveAccount();
      this.accounts = mod.storedAccounts();
      fs.rmSync(mod.authFilePath(), { force: true });
      this.accountId = null;
      this.workspaceId = null;
      await this.session?.broadcast("globalThis.__codexSetActiveAccount?.(null)");
      await this.#applySwitch({ signsOut: true });
    } catch (error) {
      await showErrorBox("Could not add a Codex account", String(error?.message ?? error));
    }
  }

  async forgetAccount(accountId) {
    try {
      const label =
        this.accounts.find((option) => option.accountId === accountId)?.label ?? accountId;
      const live = this.accountId === accountId;
      const response = await showMessageBox({
        message: live ? `Sign out and forget ${label}?` : `Forget ${label}?`,
        detail: live
          ? "This account is currently signed in. Forgetting it deletes the saved login " +
            "and signs Codex out. Add it again by signing in."
          : "This deletes the saved login for this account. Add it again by signing in with it.",
        buttons: ["Cancel", "Forget"],
        defaultId: 0,
        cancelId: 0,
        destructiveId: 1,
      });
      if (response !== 1) {
        return;
      }
      mod.removeAccountSnapshot(accountId);
      this.accounts = mod.storedAccounts();
      if (live) {
        fs.rmSync(mod.authFilePath(), { force: true });
        this.accountId = null;
        this.workspaceId = null;
        await this.session?.broadcast("globalThis.__codexSetActiveAccount?.(null)");
      }
      await this.broadcastSidebar();
      if (live) {
        await this.#applySwitch({ signsOut: true });
      }
    } catch (error) {
      await showErrorBox("Could not forget the account", String(error?.message ?? error));
    }
  }

  refreshBudget() {
    this.#usageFetchedAt = 0;
    this.#liveUsageAt = 0;
    void this.pollBudget();
  }

  // Usage belongs to the account it was fetched for; another login starts
  // from nothing rather than inheriting the previous account's limits.
  #resetUsage() {
    this.#usageWorkspaceId = this.workspaceId;
    this.#usagePayload = null;
    this.budgetPayload = null;
    this.#usageFetchedAt = 0;
    this.#liveUsageAt = 0;
    this.#failedUsagePolls = 0;
  }

  #activeProvider() {
    try {
      const configText = fs.readFileSync(path.join(mod.codexHome(), "config.toml"), "utf8");
      return mod.activeProvider(configText);
    } catch {
      return mod.OPENAI_PROVIDER;
    }
  }

  // The renderer reports the usage response behind the app's own display as
  // soon as it arrives, which keeps the sidebar in step with the app instead
  // of trailing it by a poll interval.
  async reportRateLimits(serialized) {
    let usage;
    try {
      usage = JSON.parse(serialized);
    } catch {
      return;
    }
    const rows = mod.usageRows(mod.rateLimitsFromUsage(usage));
    // An account without usage limits, such as a business workspace, reports
    // no windows at all; that replaces whatever another account left behind.
    const unlimited = rows == null && usage?.rate_limit == null && usage?.credits?.unlimited === true;
    if ((rows == null && !unlimited) || this.#activeProvider() !== mod.OPENAI_PROVIDER) {
      return;
    }
    if (typeof usage.account_id === "string" && usage.account_id !== this.workspaceId) {
      return;
    }
    if (this.#usageWorkspaceId !== this.workspaceId) {
      this.#resetUsage();
    }
    if (this.#liveUsageAt === 0) {
      log("usage now follows the renderer's reports");
    }
    this.#liveUsageAt = Date.now();
    this.#usagePayload = unlimited ? { rows: [], notice: NO_LIMIT_NOTICE, unlimited: true } : { rows };
    this.budgetPayload = this.#usagePayload;
    await this.broadcastBudget();
  }

  async pollBudget() {
    if (this.#polling) {
      return;
    }
    this.#polling = true;
    try {
      let provider = mod.OPENAI_PROVIDER;
      let source = null;
      try {
        const configText = fs.readFileSync(path.join(mod.codexHome(), "config.toml"), "utf8");
        provider = mod.activeProvider(configText);
        source = mod.providerBudgetSource(configText, provider);
      } catch {
        source = null;
      }
      const switched = provider !== this.#lastBudgetProvider;
      this.#lastBudgetProvider = provider;
      if (switched) {
        this.#failedUsagePolls = 0;
        this.#failedBudgetPolls = 0;
      }
      if (provider === mod.OPENAI_PROVIDER) {
        if (switched || this.#usageWorkspaceId !== this.workspaceId) {
          this.#resetUsage();
        }
        if (Date.now() - this.#usageFetchedAt >= mod.USAGE_POLL_INTERVAL_MS) {
          this.#usageFetchedAt = Date.now();
          const polledAccount = this.accountId;
          const outcome = await mod.readAccountRateLimits();
          if (
            polledAccount != null &&
            polledAccount === this.accountId &&
            mod.isRevokedTokenError(outcome.error)
          ) {
            await this.#dropRevokedLogin(polledAccount);
          }
          const rows = outcome.error == null ? mod.usageRows(outcome.response) : null;
          this.#failedUsagePolls = outcome.error == null ? 0 : this.#failedUsagePolls + 1;
          const liveRows = this.#usagePayload?.rows;
          const trustLive =
            liveRows != null && Date.now() - this.#liveUsageAt < mod.LIVE_USAGE_TRUST_MS;
          if (polledAccount !== this.accountId || this.#usageWorkspaceId !== this.workspaceId) {
            // The login changed while the poll ran; the next poll asks again.
            this.#resetUsage();
          } else if (trustLive) {
            // The renderer's reports are fresher than this poll, and a failure
            // here does not make the live numbers any less valid.
            if (outcome.error != null) {
              log(`usage poll failed: ${outcome.error}`);
            }
          } else if (outcome.error != null) {
            log(`usage poll failed: ${outcome.error}`);
            if (this.#failedUsagePolls >= mod.FAILED_POLLS_BEFORE_ALERT) {
              // Keep the last known rows and say why they may be stale.
              this.#usagePayload = { rows: liveRows ?? [], error: outcome.error };
            }
          } else if (rows != null) {
            this.#usagePayload = { rows };
          } else if (this.accountId != null && outcome.response?.rateLimits != null) {
            this.#usagePayload = { rows: [], notice: NO_LIMIT_NOTICE, unlimited: true };
          } else {
            // No rate limits at all, as with an API-key login: nothing to show.
            this.#usagePayload = null;
          }
        }
        this.budgetPayload = this.#usagePayload;
      } else if (source == null) {
        this.budgetPayload = { rows: [], notice: NO_USAGE_NOTICE };
      } else {
        const fetched = await mod.fetchBudget(source);
        this.#failedBudgetPolls = fetched.error == null ? 0 : this.#failedBudgetPolls + 1;
        if (fetched.unsupported) {
          this.budgetPayload = { rows: [], notice: NO_USAGE_NOTICE };
        } else if (fetched.error == null) {
          this.budgetPayload = { rows: mod.budgetRows(fetched.budget) };
        } else {
          log(`budget poll failed: ${fetched.error}`);
          if (this.#failedBudgetPolls >= mod.FAILED_POLLS_BEFORE_ALERT) {
            this.budgetPayload = { rows: this.budgetPayload?.rows ?? [], error: fetched.error };
          } else if (switched) {
            this.budgetPayload = null;
          }
        }
      }
      await this.broadcastBudget();
    } finally {
      this.#polling = false;
    }
  }
}

// Exiting is how the host picks up new sources: launchd starts it again from
// the release the `current` link names, and the new instance reloads Codex's
// pages so they pick up the rebuilt bundles.
let restartWhenCodexQuits = false;
// The installed update the banner in the main window offers to apply.
let pendingUpdate = null;

function restartHost(reason) {
  log(`${reason}; exiting so the launch agent restarts the host`);
  shutdown("SIGTERM");
}

let lastUpdateError = null;
// A newer release that does not run on the installed Codex: below its
// minimum build or patching it less completely than the running release.
let blockedRelease = null;
let updateCheckRunning = false;
// What the settings page shows about updates: the newest published release
// the last check saw, and what the host is doing about it.
let latestRelease = null;
let updateActivity = null;
// Set by the Apply now and Install buttons: the next apply runs right away,
// even with automatic updates off.
let installRequested = false;

function automaticUpdates() {
  return readModConfig().automaticUpdates !== false;
}

function setAutomaticUpdates(enabled) {
  const config = readModConfig();
  if (enabled) {
    delete config.automaticUpdates;
  } else {
    config.automaticUpdates = false;
  }
  fs.writeFileSync(MOD_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function setUpdateActivity(activity) {
  updateActivity = activity;
  void modState?.broadcastSettings();
}

function updateStatus() {
  const appVersion = codexAppVersion(BUNDLE);
  const available =
    latestRelease != null && newerRelease(latestRelease.version, LOADED_RELEASE) ? latestRelease : null;
  return {
    selfUpdating: INSTALL_MODE === "release",
    automatic: automaticUpdates(),
    latest: latestRelease?.version ?? null,
    available: available?.version ?? null,
    blocked:
      available != null && blockedRelease?.version === available.version && blockedRelease.codex === appVersion
        ? { minimum: blockedRelease.minimum, codex: appVersion }
        : null,
    activity: updateActivity,
    error: lastUpdateError,
  };
}

// Logged on every change of reason, not on every check.
function logUpdateError(message) {
  if (message !== lastUpdateError) {
    lastUpdateError = message;
    log(message);
  }
}

// Checks overlap otherwise: an update can wait to be applied past the next
// tick. An install requested while a check runs gets a check of
// its own once that one is done, unless it already ended the wait.
async function checkForUpdate() {
  if (updateCheckRunning) {
    return;
  }
  updateCheckRunning = true;
  try {
    do {
      const manual = installRequested;
      installRequested = false;
      if (INSTALL_MODE === "legacy-checkout") {
        await migrateFromCheckout();
      } else if (INSTALL_MODE === "release") {
        await updateRelease(manual);
      } else {
        await refreshLatestRelease();
      }
    } while (installRequested);
  } finally {
    updateCheckRunning = false;
    setUpdateActivity(restartWhenCodexQuits ? "waiting" : null);
  }
}

function requestInstall() {
  installRequested = true;
  void checkForUpdate();
}

// A development checkout never updates itself; its settings page still shows
// what the newest release is.
async function refreshLatestRelease() {
  setUpdateActivity("checking");
  try {
    latestRelease = await fetchLatestRelease();
    lastUpdateError = null;
  } catch (error) {
    logUpdateError(`update check failed: ${error.message}`);
  }
}

// A release that does not run on the installed Codex is downloaded ahead
// of the Codex update it waits for. Codex restarts for its own update anyway,
// so once the release passed its trial on the new build the host switches to
// it right away instead of asking first.
function switchToDownloadedRelease(reason) {
  if (INSTALL_MODE !== "release" || !automaticUpdates()) {
    return false;
  }
  const downloaded = newestDownloadedRelease(currentReleaseVersion() ?? LOADED_RELEASE, codexAppVersion(BUNDLE));
  if (downloaded == null || recordedTrial(downloaded.version)?.lost.length !== 0) {
    return false;
  }
  activateRelease(downloaded.version);
  restartHost(`${reason}; switching to release ${downloaded.version}, downloaded for this Codex build`);
  return true;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// The verdict of an earlier trial of `version` on the installed Codex build
// against the running release, or null when there was none.
function recordedTrial(version) {
  const trial = readJsonFile(path.join(releaseDirectory(version), TRIAL_FILE));
  let header;
  try {
    header = asarHeaderSha256(ASAR);
  } catch {
    return null;
  }
  return trial?.asar_header_sha256 === header && trial.against === LOADED_RELEASE && Array.isArray(trial.lost)
    ? trial
    : null;
}

// What release `version` would lose on the installed Codex compared with the
// running release: the patches the running release applies and the release
// does not. Its patcher builds the renderer cache into a trial directory,
// which becomes the cache when nothing is lost, so applying the release needs
// no second build. A release that cannot build the cache at all loses
// everything a patched cache gives, and nothing while none is served.
async function trialRelease(version) {
  const recorded = recordedTrial(version);
  if (recorded != null) {
    return recorded.lost;
  }
  const trialDir = `${CACHE_DIR}.trial`;
  fs.rmSync(trialDir, { recursive: true, force: true });
  const header = asarHeaderSha256(ASAR);
  const result = await runCli(
    ["build-cache", "--asar", ASAR, "--renderer-cache", trialDir],
    RENDERER_CACHE_TIMEOUT_MS,
    path.join(releaseDirectory(version), "scripts/codex_mod.mjs"),
  );
  let lost;
  if (result.status !== 0) {
    lost = rendererCache == null ? [] : ["the patched bundles"];
  } else {
    lost = lostPatches(rendererCache?.manifest.patches, readJsonFile(path.join(trialDir, "manifest.json"))?.patches);
  }
  if (result.status === 0 && lost.length === 0) {
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    fs.renameSync(trialDir, CACHE_DIR);
  } else {
    fs.rmSync(trialDir, { recursive: true, force: true });
  }
  fs.writeFileSync(
    path.join(releaseDirectory(version), TRIAL_FILE),
    `${JSON.stringify({ asar_header_sha256: header, against: LOADED_RELEASE, lost }, null, 2)}\n`,
  );
  return lost;
}

// Records the release that waits for a Codex update, logs every change of
// reason and tells the user once per Codex build.
function blockRelease(version, appVersion, { minimum = null, lost = [] }) {
  const blocked = { version, codex: appVersion, minimum, lost };
  if (JSON.stringify(blocked) !== JSON.stringify(blockedRelease)) {
    const reason = minimum != null ? `needs Codex ${minimum} or newer` : `would lose ${lost.join(", ")}`;
    log(`release ${version} ${reason} on the installed Codex ${appVersion ?? "(unknown)"}; waiting for a Codex update`);
  }
  blockedRelease = blocked;
  void modState?.showIncompatibleNotice();
}

function incompatibleNoticeDue() {
  if (blockedRelease == null || !automaticUpdates()) {
    return false;
  }
  try {
    return fs.readFileSync(INCOMPATIBLE_NOTICE_FILE, "utf8").trim() !== blockedRelease.codex;
  } catch {
    return true;
  }
}

function dismissIncompatibleNotice(codex) {
  if (blockedRelease?.codex !== codex) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(INCOMPATIBLE_NOTICE_FILE), { recursive: true });
    fs.writeFileSync(INCOMPATIBLE_NOTICE_FILE, `${codex}\n`);
    log(`notice about release ${blockedRelease.version} dismissed for Codex ${codex}`);
  } catch (error) {
    log(`could not record the dismissed notice: ${error.message}`);
  }
}

// A checkout that a release before 5.0.0 installed moves into a release
// install. The agent reload that follows ends this host, and launchd starts
// the release's host, which serves the same bundles without a reload.
async function migrateFromCheckout() {
  try {
    const version = await migrateCheckoutInstall({ node: process.execPath, codexHome: AGENT_CODEX_HOME });
    log(`installed release ${version}; its host removes the checkout at ${SOURCE_ROOT}`);
    return true;
  } catch (error) {
    logUpdateError(`moving the install out of the checkout failed: ${error.message}; retrying at the next check`);
    return false;
  }
}

// Downloading and applying are separate steps. Applying is decided by
// comparing the release the `current` link names with the one this process
// loaded, not by whether this check downloaded, so an apply that fails, such
// as a cache build cut short by sleep, is retried on every check until the
// host runs the linked release.
//
// With automatic updates off, checks only report the newest release to the
// settings page; the Install button applies it.
async function updateRelease(manual) {
  const automatic = automaticUpdates();
  setUpdateActivity("checking");
  try {
    const latest = await fetchLatestRelease();
    latestRelease = latest;
    if (lastUpdateError !== null) {
      lastUpdateError = null;
      log("update check: releases reachable again");
    }
    const appVersion = codexAppVersion(BUNDLE);
    if (!newerRelease(latest.version, currentReleaseVersion() ?? LOADED_RELEASE)) {
      blockedRelease = null;
    } else if (!supportsCodex(latest, appVersion)) {
      blockRelease(latest.version, appVersion, { minimum: latest.minimumCodexVersion });
      if (automatic) {
        await downloadRelease(latest);
      }
    } else if (automatic || manual) {
      setUpdateActivity("installing");
      await downloadRelease(latest);
      const lost = await trialRelease(latest.version);
      if (lost.length > 0) {
        blockRelease(latest.version, appVersion, { lost });
      } else {
        blockedRelease = null;
        log(`release ${latest.version} is available; updating from ${LOADED_RELEASE ?? "an unknown release"}`);
        activateRelease(latest.version);
      }
    }
  } catch (error) {
    logUpdateError(`update check failed: ${error.message}`);
  }
  const linked = currentReleaseVersion();
  if (linked == null || linked === LOADED_RELEASE || restartWhenCodexQuits) {
    return;
  }
  setUpdateActivity("installing");
  try {
    await refreshRendererCache();
  } catch (error) {
    // A host that serves patched bundles keeps them until the release builds
    // its own. One that serves none has nothing to lose, and the release may
    // carry a fix outside the patcher, so it switches regardless.
    if (rendererCache != null) {
      log(`update failed: ${error.message}; retrying at the next check`);
      return;
    }
    log(`release ${linked} cannot build the renderer cache either (${error.message}); switching to it`);
  }
  const installed = `Codex Mod ${linked} installed`;
  if (codexPids().length === 0) {
    restartHost(installed);
    return;
  }
  // Applying reloads the windows like a Codex update does: running threads
  // continue, and the main window comes back in its thread with its draft.
  // While Codex runs, the user decides when; quitting Codex applies it too.
  if (!manual && !installRequested) {
    restartWhenCodexQuits = true;
    setUpdateActivity("waiting");
    log(`${installed}; applying once the user applies it or quits Codex`);
    await waitForApply({ version: linked });
  }
  const session = modState?.session;
  const sessionId = session?.mainPageSessionId();
  if (sessionId != null && (await session.evaluate(sessionId, mod.applyingScript("Updating Codex Mod")))) {
    await sleep(UPDATE_PILL_MS);
  }
  restartHost(installed);
}

// Resolves once the user applies the update from the banner in the main
// window or from the settings page. Without a main window to show the banner
// in, for two checks in a row so a reload does not count, it resolves right
// away: nothing is interrupted then.
async function waitForApply(notice) {
  pendingUpdate = notice;
  let missing = 0;
  try {
    while (!installRequested) {
      const session = modState?.session;
      const sessionId = session?.mainPageSessionId();
      if (sessionId == null) {
        missing += 1;
        if (missing >= 2) {
          return;
        }
      } else {
        missing = 0;
        await session.evaluate(sessionId, mod.readyNoticeScript(notice));
      }
      await sleep(APPLY_POLL_INTERVAL_MS);
    }
  } finally {
    pendingUpdate = null;
  }
}

// Whether a Codex with the debugging switch answers on the port right now.
async function devToolsReachable(timeoutMs) {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// The DevTools connection also drops for a moment while Codex reloads, so a
// quit only counts once no Codex process is left. A swap the host made since
// the connection opened is no quit: the host attaches to the Codex it
// launched right away, before its window loads stock.
async function codexQuit(swapsAtConnect) {
  if (relaunchingCodex || codexSwaps !== swapsAtConnect) {
    while (relaunchingCodex) {
      await sleep(100);
    }
    return codexPids().length === 0;
  }
  const deadline = Date.now() + 10000;
  while (codexPids().length > 0) {
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(500);
  }
  return true;
}

async function waitForDevTools() {
  while (!(await devToolsReachable(LIVENESS_PROBE_TIMEOUT_MS))) {
    await sleep(200);
  }
}

// A Codex that macOS reopened at login, or that was started while the host
// was down, runs without the debugging switch and so without the mod. The
// host swaps it for a flagged one the moment it notices, the same way the
// launch watcher does for a Dock launch.
// Codex hides every turn after a rollout ordinal that stopped increasing,
// which it writes itself when it resumes a thread that was quit mid-turn. The
// files can only be rewritten while no app-server appends to them.
let repairingRollouts = false;

async function repairRolloutsWhenIdle() {
  if (repairingRollouts) {
    return;
  }
  repairingRollouts = true;
  try {
    const deadline = Date.now() + 30000;
    while (codexPids().length > 0 && Date.now() < deadline) {
      await sleep(500);
    }
    if (codexPids().length > 0) {
      return;
    }
    const repairs = repairRollouts({ log: (message) => log(`rollout repair: ${message}`) });
    if (repairs.length > 0) {
      log(`rollout repair: ${repairs.length} thread(s) show their full history again`);
    }
  } catch (error) {
    log(`rollout repair failed: ${error.message}`);
  } finally {
    repairingRollouts = false;
  }
}

// A shell that fails at login, before the keychain or a network mount is
// ready, would otherwise leave provider keys missing until the next restart.
async function retryShellEnvironment(state) {
  for (;;) {
    await sleep(SHELL_ENVIRONMENT_RETRY_MS);
    const loaded = await loadShellEnvironment();
    if (loaded != null) {
      log(`loaded ${loaded} variable(s) from the login shell on a retry`);
      state.refreshBudget();
      return;
    }
  }
}

async function relaunchIfUnflagged() {
  const unflagged = codexPids().filter((pid) => !processArguments(pid).includes("--remote-debugging-port="));
  if (unflagged.length === 0) {
    return;
  }
  log(`relaunching unflagged Codex ${unflagged.join(", ")} found at host start`);
  await relaunchCodex();
}

const MODE_DESCRIPTIONS = {
  release: "",
  development: " from a development checkout, which does not update itself",
  "legacy-checkout": " from a checkout an earlier release installed",
};

async function main() {
  log(`running Codex Mod ${LOADED_RELEASE ?? "(untagged)"}${MODE_DESCRIPTIONS[INSTALL_MODE]}`);
  if (INSTALL_MODE === "legacy-checkout" && (await migrateFromCheckout())) {
    // launchd ends this host once the agent reloads from the release install.
    await sleep(60000);
    log("the launch agent did not reload; running from the checkout until the next check");
  }
  if (INSTALL_MODE === "release") {
    if (switchToDownloadedRelease("the installed Codex build is new")) {
      return;
    }
    const downloaded = newestDownloadedRelease(currentReleaseVersion() ?? LOADED_RELEASE);
    pruneReleases([path.basename(SOURCE_ROOT), currentReleaseVersion(), downloaded?.version].filter(Boolean));
    removeRetiredCheckout((line) => log(line));
  }
  // The watcher goes first so a Codex launched during the slower startup
  // steps below is caught and relaunched instead of coming up unpatched.
  startLaunchWatcher();
  // A Codex that keeps running across an update starts its next app-server
  // through the wrapper this release writes.
  try {
    if (fs.existsSync(CLI_WRAPPER)) {
      writeCliWrapper();
    }
  } catch (error) {
    log(`could not write the CLI wrapper: ${error.message}`);
  }
  // Update checks run even while the cache build keeps failing: a release
  // that matches a changed Codex build is how such a host recovers.
  setInterval(() => void checkForUpdate().catch((error) => log(error.message)), UPDATE_CHECK_INTERVAL_MS);
  const loaded = await loadShellEnvironment();
  if (loaded == null) {
    log("loading the login shell environment failed; retrying every minute");
  } else {
    log(`loaded ${loaded} variable(s) from the login shell`);
  }
  await ensureRendererCache();
  watchCodexBundle();
  const state = new ModState();
  modState = state;
  // A host starts with every Codex launch, which is when a release that
  // came out in the meantime is least in the way.
  void checkForUpdate().catch((error) => log(error.message));
  setInterval(() => {
    const providersChanged = state.syncProviders();
    if (providersChanged) {
      log(`profiles now: ${state.providers.map((option) => option.label).join(", ")}`);
    }
    const accountsChanged = state.syncAccounts();
    if (accountsChanged || providersChanged) {
      void state.broadcastSidebar();
    }
    if (accountsChanged) {
      void state.broadcastSettings();
    }
  }, mod.AUTH_SYNC_INTERVAL_MS);
  setInterval(() => void state.pollBudget(), mod.BUDGET_POLL_INTERVAL_MS);
  if (loaded == null) {
    void retryShellEnvironment(state);
  }
  if (codexPids().length === 0) {
    await repairRolloutsWhenIdle();
  }
  void relaunchIfUnflagged();

  for (;;) {
    await waitForDevTools();
    const swapsAtConnect = codexSwaps;
    let client;
    try {
      client = await DevToolsClient.connect(PORT);
    } catch (error) {
      log("connect failed:", error.message);
      await sleep(500);
      continue;
    }
    log(`attached to Codex on port ${PORT}`);
    const session = new ModSession(client, state);
    state.session = session;
    const closed = new Promise((resolve) => client.onClose(resolve));
    try {
      await session.start();
      void state.pollBudget();
    } catch (error) {
      log("session start failed:", error.message);
    }
    await closed;
    session.stop();
    state.session = null;
    log("DevTools connection ended; waiting for Codex");
    if (restartWhenCodexQuits) {
      restartHost("applying the postponed update");
    } else if (await codexQuit(swapsAtConnect)) {
      // Every Codex session gets a fresh host, so state that went stale, such
      // as a shell environment that failed to load, never outlives a quit.
      // The new host repairs rollouts on startup while Codex is not running.
      restartHost("Codex quit");
    } else {
      void repairRolloutsWhenIdle();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
