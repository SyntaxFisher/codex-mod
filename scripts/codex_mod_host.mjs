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

if (typeof WebSocket !== "function") {
  console.error("codex-mod-host needs Node.js 22 or newer");
  process.exit(1);
}

const require = createRequire(import.meta.url);
const mod = require("./profile_switcher.cjs");
const { repairRollouts } = require("./rollout_repair.cjs");
const { watchOpenRollouts, stripForeignReasoning } = require("./encrypted_reasoning.cjs");

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(SCRIPT_DIR);
const PORT = Number(process.env.CODEX_MOD_CDP_PORT || 48123);
const PYTHON = process.env.CODEX_MOD_PYTHON || "python3";
const PATCHER = path.join(SCRIPT_DIR, "patch_codex.py");
const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const ATTACH_CHECK_INTERVAL_MS = 30 * 1000;
const BUNDLE = ["/Applications/ChatGPT.app", "/Applications/Codex.app"].find((candidate) =>
  fs.existsSync(candidate),
);
if (BUNDLE == null) {
  console.error("codex-mod-host found no Codex application under /Applications");
  process.exit(1);
}
const ASAR = path.join(BUNDLE, "Contents/Resources/app.asar");
const CACHE_DIR = path.join(mod.codexHome(), ".codex-mod-renderer-cache");
const WATCHER = path.join(REPO_ROOT, "build/launch-watcher");
const ASSET_URL_PREFIX = "app://-/assets/";

const log = (...parts) =>
  console.log(new Date().toISOString().slice(11, 23), "[codex-mod-host]", ...parts);

function runPatcher(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, [PATCHER, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = timeoutMs ? setTimeout(() => child.kill("SIGKILL"), timeoutMs) : null;
    child.on("error", (error) => resolve({ status: null, stdout, stderr: String(error) }));
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
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

let rendererCache = null;
let cacheBuild = null;

// The patcher reuses a cache built from the installed Codex build and the
// current sources, so a rebuild only costs time when either changed.
function refreshRendererCache() {
  if (cacheBuild == null) {
    cacheBuild = (async () => {
      const result = await runPatcher(["--asar", ASAR, "--renderer-cache", CACHE_DIR], 120000);
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
let modState = null;

// Every dialog is the in-page modal of the main Codex window. A native
// dialog only stands in while no Codex window is attached; a window that
// cannot answer counts as cancel, so the native dialog never appears next
// to a running Codex.
async function showMessageBox(options) {
  const cancel = () =>
    options.fields?.length > 0
      ? { button: options.cancelId ?? 0, values: {} }
      : options.cancelId ?? options.defaultId ?? 0;
  const session = modState?.session;
  const sessionId = session?.mainPageSessionId();
  if (sessionId == null) {
    return options.fields?.length > 0 ? cancel() : showNativeMessageBox(options);
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
  if (typeof answer === "number" || (answer != null && typeof answer === "object")) {
    return answer;
  }
  log(`the Codex window did not answer the dialog "${options.message}" (${JSON.stringify(answer)})`);
  return cancel();
}

// Opens config.toml in the editor Codex itself is set to open paths in,
// falling back to the default text editor.
function openConfigFile() {
  const configPath = path.join(mod.codexHome(), "config.toml");
  const editors = {
    cursor: "Cursor",
    vscode: "Visual Studio Code",
    "vscode-insiders": "Visual Studio Code - Insiders",
    zed: "Zed",
    windsurf: "Windsurf",
  };
  let preferred = null;
  try {
    const configText = fs.readFileSync(configPath, "utf8");
    preferred =
      configText.match(/^\s*global\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m)?.[1] ?? null;
  } catch {
    preferred = null;
  }
  const app = preferred == null ? null : editors[preferred] ?? null;
  const attempt = app == null ? ["-t", configPath] : ["-a", app, configPath];
  const result = spawnSync("/usr/bin/open", attempt, { encoding: "utf8" });
  if (result.status !== 0 && app != null) {
    spawnSync("/usr/bin/open", ["-t", configPath]);
  }
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

function codexPids() {
  const result = spawnSync("/usr/bin/pgrep", ["-f", path.join(BUNDLE, "Contents/MacOS/")], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.split(/\s+/).filter(Boolean).map(Number) : [];
}

function appServerPids() {
  const pattern = `${path.join(BUNDLE, "Contents/Resources/codex")} .*app-server`;
  const result = spawnSync("/usr/bin/pgrep", ["-f", pattern], { encoding: "utf8" });
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

// LaunchServices refuses a launch while it still considers the process just
// killed to be starting, so the request is repeated until a flagged process
// exists.
async function launchCodex() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = spawnSync("/usr/bin/open", [BUNDLE, "--args", `--remote-debugging-port=${PORT}`], {
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

async function relaunchCodex() {
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
    log(`launch watcher missing (${WATCHER}); run make install`);
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
// the user to confirm. The patcher's uninstall boots this very host out of
// launchd, so it runs detached and finishes on its own: after the host is
// gone it starts Codex again without the debugging switch.
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
      `${JSON.stringify(PYTHON)} ${JSON.stringify(PATCHER)} --asar ${JSON.stringify(ASAR)} ` +
      `--renderer-cache ${JSON.stringify(CACHE_DIR)} --uninstall; ` +
      `/usr/bin/open ${JSON.stringify(BUNDLE)}`;
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
function loadShellEnvironment() {
  const shell = process.env.SHELL || "/bin/zsh";
  return new Promise((resolve) => {
    const child = spawn(shell, ["-ilc", "/usr/bin/env -0"], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", () => resolve(0));
    child.on("close", (status) => {
      clearTimeout(timer);
      if (status !== 0) {
        resolve(0);
        return;
      }
      let added = 0;
      for (const entry of Buffer.concat(chunks).toString("utf8").split("\0")) {
        const separator = entry.indexOf("=");
        if (separator <= 0) {
          continue;
        }
        const name = entry.slice(0, separator);
        if (name !== "PATH" && !(name in process.env)) {
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
    this.#socket.onclose = callback;
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve) => {
      const id = this.#nextId++;
      this.#pending.set(id, resolve);
      this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
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
  // Targets whose bundles this session already served, so a page session
  // that Codex drops can be picked up again without reloading the page.
  #patchedTargets = new Set();
  #attachCheck = null;
  #attaching = false;

  constructor(client, state) {
    this.#client = client;
    this.#state = state;
  }

  async start() {
    const client = this.#client;
    client.handlers.add((message) => void this.#handleEvent(message));
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
  // so existing pages are checked and re-attached explicitly.
  async attachUnattachedPages() {
    if (this.#attaching) {
      return;
    }
    this.#attaching = true;
    try {
      const { targetInfos } = await this.#client.call("Target.getTargets");
      for (const target of targetInfos) {
        if (target.type !== "page" || target.attached) {
          continue;
        }
        if (this.#patchedTargets.has(target.targetId)) {
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

  async #handleEvent(message) {
    const { method, params, sessionId } = message;
    if (method === "Target.attachedToTarget") {
      await this.#attached(params);
    } else if (method === "Target.detachedFromTarget") {
      const page = this.pages.get(params.sessionId);
      this.pages.delete(params.sessionId);
      if (page != null) {
        log(`page session detached: ${page.url}`);
        await this.attachUnattachedPages();
      }
    } else if (method === "Target.targetDestroyed") {
      this.#patchedTargets.delete(params.targetId);
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
    const reattached = this.#patchedTargets.has(targetInfo.targetId);
    this.#patchedTargets.add(targetInfo.targetId);
    if (rendererCache != null && !rendererCache.matchesInstalledCodex()) {
      // Codex updated itself; the stale bundles no longer match the new file
      // names, so the page loads stock until the rebuilt cache reloads it.
      log("Codex changed since the cache was built; rebuilding");
      refreshRendererCache()
        .then(() => this.#reloadPagesWithCurrentCache())
        .catch((error) => log(error.message));
    }
    await this.#interceptAssets(sessionId);
    // Commands needing a JavaScript context block while the target is paused,
    // so nothing but Fetch is configured before the page resumes.
    if (waitingForDebugger) {
      await client.call("Runtime.runIfWaitingForDebugger", {}, sessionId);
    }
    await client.call("Page.enable", {}, sessionId);
    await client.call("Runtime.enable", {}, sessionId);
    await client.call("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);
    if (reattached) {
      // The page still runs the patched bundles; only the injected controls
      // need the current state again.
      log("re-attached to page:", targetInfo.url);
      await this.#state.renderInto(this, sessionId);
    } else if (!waitingForDebugger && targetInfo.url.startsWith("app://")) {
      // A page that loaded before the host attached runs the stock bundles.
      log("reloading page that loaded before attach:", targetInfo.url);
      await client.call("Page.reload", {}, sessionId);
    }
  }

  // Registers the cached bundle names with the page's request interception.
  // Calling it again replaces the earlier patterns, which a page needs once a
  // rebuilt cache carries different file names.
  async #interceptAssets(sessionId) {
    const patterns = [...rendererCache.files.keys()].map((name) => ({
      urlPattern: `${ASSET_URL_PREFIX}${name}`,
      requestStage: "Request",
    }));
    if (patterns.length > 0) {
      await this.#client.call("Fetch.enable", { patterns }, sessionId);
    }
  }

  // A page attached while the cache was stale intercepts the old bundle
  // names; a reload alone would load stock again.
  async #reloadPagesWithCurrentCache() {
    for (const sessionId of this.pages.keys()) {
      try {
        await this.#interceptAssets(sessionId);
      } catch (error) {
        log(`could not update interception for a page: ${error.message}`);
      }
    }
    await this.reloadPages();
  }

  async #serve(sessionId, { requestId, request }) {
    const name = path.basename(new URL(request.url).pathname);
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
    if (!this.pages.has(sessionId)) {
      return;
    }
    await this.#state.renderInto(this, sessionId);
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

  async broadcast(expression) {
    await Promise.allSettled(
      [...this.pages.keys()].map((sessionId) => this.evaluate(sessionId, expression)),
    );
  }

  // Types text into the main page's composer and submits it through the
  // same input path as the keyboard, so the app sends it like any message.
  async submitComposer(sessionId, text) {
    if ((await this.evaluate(sessionId, mod.focusComposerScript())) !== true) {
      return false;
    }
    await this.#client.call("Input.insertText", { text }, sessionId);
    return this.pressEnter(sessionId);
  }

  async pressEnter(sessionId) {
    const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    try {
      await this.#client.call("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", unmodifiedText: "\r", ...enter }, sessionId);
      await this.#client.call("Input.dispatchKeyEvent", { type: "keyUp", ...enter }, sessionId);
      return true;
    } catch {
      return false;
    }
  }

  async reloadPages() {
    await sleep(750);
    let reloaded = false;
    for (const sessionId of this.pages.keys()) {
      try {
        await this.#client.call("Page.reload", {}, sessionId);
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
  accountId = null;
  accounts = [];
  budgetPayload = null;
  #usagePayload = null;
  #usageFetchedAt = 0;
  #liveUsageAt = 0;
  #lastBudgetProvider = null;
  #polling = false;

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
    fs.rmSync(mod.accountSnapshotPath(accountId), { force: true });
    log(`${label} ${reason}; removed its saved login from the switcher`);
  }

  async #dropRevokedLogin(accountId) {
    this.#dropSnapshot(accountId, "no longer has a valid login");
    fs.rmSync(mod.authFilePath(), { force: true });
    this.accountId = null;
    this.accounts = mod.storedAccounts();
    await this.session?.broadcast("globalThis.__codexSetActiveAccount?.(null)");
    await this.broadcastSidebar();
  }

  sidebarScript() {
    return (
      `${mod.activeProviderSyncScript(this.provider)};` +
      mod.sidebarProfileScript(this.provider, this.providers, this.accountId, this.accounts)
    );
  }

  versionScript() {
    const manifest = rendererCache?.manifest;
    return mod.settingsVersionScript(manifest?.version ?? "unknown", manifest?.describe ?? null);
  }

  async renderInto(session, sessionId) {
    await session.evaluate(sessionId, mod.modalScript());
    await session.evaluate(sessionId, this.sidebarScript());
    await session.evaluate(sessionId, mod.sidebarBudgetScript(this.budgetPayload));
    await session.evaluate(sessionId, this.versionScript());
  }

  async broadcastSidebar() {
    await this.session?.broadcast(this.sidebarScript());
  }

  async broadcastBudget() {
    await this.session?.broadcast(mod.sidebarBudgetScript(this.budgetPayload));
  }

  handleConsoleMessage(text) {
    const prefixes = {
      "__codex_profile_switch__:": (value) =>
        this.providers.some((option) => option.provider === value) && this.switchProvider(value),
      "__codex_account_switch__:": (value) =>
        this.accounts.some((option) => option.accountId === value) && this.switchAccount(value),
      "__codex_account_forget__:": (value) =>
        this.accounts.some((option) => option.accountId === value) && this.forgetAccount(value),
      "__codex_profile_remove__:": (value) =>
        value !== mod.OPENAI_PROVIDER &&
        this.providers.some((option) => option.provider === value) &&
        this.removeProfile(value),
    };
    if (text === "__codex_account_add__") {
      void this.addAccount();
      return;
    }
    if (text === "__codex_profile_add__") {
      void this.addProfile();
      return;
    }
    if (text === "__codex_mod_uninstall__") {
      void uninstallMod();
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

  // Reloads the windows after a switch and brings the thread that was open
  // back, since a reload lands on the new-chat page.
  async #applySwitch() {
    const session = this.session;
    const sessionId = session?.mainPageSessionId();
    const threadId = sessionId == null ? null : await session.evaluate(sessionId, mod.activeThreadScript());
    if (!(await this.#restartHost()) || !(await session?.reloadPages())) {
      await relaunchCodex();
      return;
    }
    if (typeof threadId === "string") {
      void this.#reopenThread(threadId);
    }
  }

  async #reopenThread(threadId) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const session = this.session;
      const sessionId = session?.mainPageSessionId();
      if (sessionId != null && (await session.prompt(sessionId, mod.showThreadScript(threadId), 8000)) === true) {
        return;
      }
      await sleep(500);
    }
    log(`thread ${threadId} is not in the sidebar after the reload; open it by hand`);
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
    try {
      if (!(await this.#setProvider(provider))) {
        return;
      }
      this.refreshBudget();
      await this.#applySwitch();
    } catch (error) {
      await showErrorBox("Could not switch Codex profile", String(error?.message ?? error));
    }
  }

  // Offered when a turn fails because the thread carries reasoning that
  // another profile's organization encrypted. Blanking it and restarting the
  // app-server lets the thread continue; the windows stay as they are, and
  // the failed message is sent again.
  async offerReasoningStrip({ file, threadId, turnId, itemId, text }) {
    const label = this.providers.find((option) => option.provider === this.provider)?.label ?? this.provider;
    log(`thread ${threadId} failed under ${this.provider} on encrypted reasoning${itemId ? ` ${itemId}` : ""}`);
    const response = await showMessageBox({
      message: `Switch this thread to ${label}?`,
      detail:
        "Its reasoning is encrypted for another profile and has to be " +
        `stripped to continue with ${label}. Switching stops running threads ` +
        "and sends your message again.",
      buttons: ["Cancel", "Switch"],
      defaultId: 1,
      cancelId: 0,
    });
    if (response !== 1) {
      log(`thread ${threadId} is kept as it is`);
      return;
    }
    try {
      const stripped = stripForeignReasoning({
        file,
        provider: this.provider,
        itemId,
        log: (message) => log(`reasoning strip: ${message}`),
      });
      if (stripped.length === 0) {
        await showErrorBox(
          "Nothing to blank",
          `Every reasoning item in this thread was made under ${label}; the error has another cause.`,
        );
        return;
      }
      const previousPids = appServerPids();
      if (!(await this.#restartHost())) {
        await showErrorBox(
          "Restart Codex to continue this thread",
          "The reasoning is blanked, but Codex could not be reconnected to its threads from here.",
        );
        return;
      }
      await this.#resend(threadId, turnId, text, previousPids);
    } catch (error) {
      await showErrorBox("Could not blank the reasoning", String(error?.message ?? error));
    }
  }

  // Sends the failed message again once a new app-server is up: through
  // Codex's edit action, which replaces the failed turn, else through the
  // composer. The thread is opened first when another view is showing.
  async #resend(threadId, turnId, text, previousPids) {
    if (text == null) {
      log(`thread ${threadId}: no message text to send again`);
      return;
    }
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !appServerPids().some((pid) => !previousPids.includes(pid))) {
      await sleep(250);
    }
    await sleep(2000);
    const session = this.session;
    const sessionId = session?.mainPageSessionId();
    const shown = sessionId == null ? false : await session.prompt(sessionId, mod.showThreadScript(threadId), 8000);
    if (shown !== true) {
      await this.#resendFailed(threadId);
      return;
    }
    if (turnId != null && (await this.#editLastTurn(sessionId, threadId, turnId, text))) {
      log(`thread ${threadId}: message sent again in place of the failed one`);
      return;
    }
    if (!(await session.submitComposer(sessionId, text))) {
      await this.#resendFailed(threadId);
      return;
    }
    await sleep(3000);
    if ((await session.evaluate(sessionId, mod.composerTextScript())) === text) {
      log(`thread ${threadId}: the message stayed in the composer; sending it needs a click`);
      return;
    }
    log(`thread ${threadId}: message sent again`);
  }

  // Retries the edit action while the renderer is still resuming the thread
  // from the new app-server; false when the bridge is missing or the action
  // keeps failing.
  async #editLastTurn(sessionId, threadId, turnId, text) {
    const session = this.session;
    const deadline = Date.now() + 20000;
    let result = "missing";
    while (Date.now() < deadline) {
      result = await session.prompt(sessionId, mod.editLastTurnScript(threadId, turnId, text), 30000);
      if (result === "sent") {
        return true;
      }
      if (result === "missing") {
        break;
      }
      await sleep(1000);
    }
    log(`thread ${threadId}: edit action ${result === "missing" ? "is not installed" : result}`);
    return false;
  }

  async #resendFailed(threadId) {
    log(`thread ${threadId}: could not reach its composer; the message has to be sent by hand`);
    await showErrorBox("Send your message again", "The reasoning is blanked, but the message could not be sent from here.");
  }

  async switchAccount(accountId) {
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
      this.accounts = mod.storedAccounts();
      await this.session?.broadcast(
        `globalThis.__codexSetActiveAccount?.(${JSON.stringify(accountId)})`,
      );
      this.refreshBudget();
      await this.#applySwitch();
    } catch (error) {
      await showErrorBox("Could not switch Codex account", String(error?.message ?? error));
    }
  }

  async addAccount() {
    try {
      if (mod.readAuthJson() != null && mod.backUpActiveAccount() == null) {
        await showErrorBox(
          "Could not add a Codex account",
          "The current login is not a ChatGPT account, so signing out would lose it. " +
            "Sign out through Codex itself first.",
        );
        return;
      }
    } catch (error) {
      await showErrorBox("Could not add a Codex account", String(error?.message ?? error));
      return;
    }
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
      await this.session?.broadcast("globalThis.__codexSetActiveAccount?.(null)");
      await this.#applySwitch();
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
      fs.rmSync(mod.accountSnapshotPath(accountId), { force: true });
      this.accounts = mod.storedAccounts();
      if (live) {
        fs.rmSync(mod.authFilePath(), { force: true });
        this.accountId = null;
        await this.session?.broadcast("globalThis.__codexSetActiveAccount?.(null)");
      }
      await this.broadcastSidebar();
      if (live) {
        await this.#applySwitch();
      }
    } catch (error) {
      await showErrorBox("Could not forget the account", String(error?.message ?? error));
    }
  }

  // Shows the add-profile form until it validates or is cancelled, then
  // appends the section to config.toml and pushes the new list out.
  async addProfile() {
    try {
      let values = { name: "", baseUrl: "", envKey: "" };
      let errors = {};
      for (;;) {
        const response = await showMessageBox({
          message: "Add profile",
          detail: "Adds an OpenAI-compatible provider to config.toml.",
          fields: [
            {
              name: "name",
              label: "Name",
              placeholder: "My proxy",
              hint: "Shown in the menu. The id in config.toml is derived from it.",
              value: values.name,
            },
            {
              name: "baseUrl",
              label: "Base URL",
              placeholder: "https://proxy.example.com/v1",
              hint: "Codex requires the URL to end in /v1.",
              value: values.baseUrl,
            },
            {
              name: "envKey",
              label: "API key variable",
              placeholder: "OPENAI_API_KEY",
              hint: "Optional. Export it in your login shell.",
              value: values.envKey,
            },
          ],
          errors,
          links: [{ id: "config", label: "Edit config.toml instead" }],
          buttons: ["Cancel", "Add"],
          defaultId: 1,
          cancelId: 0,
        });
        if (response?.button === "config") {
          openConfigFile();
          return;
        }
        if (response?.button !== 1) {
          return;
        }
        const result = mod.addProvider(response.values);
        values = result.values;
        if (result.errors != null) {
          errors = result.errors;
          continue;
        }
        log(`added profile ${result.provider}`);
        this.syncProviders();
        await this.broadcastSidebar();
        // Adding a profile switches to it right away, like selecting it in
        // the menu would.
        await this.switchProvider(result.provider);
        return;
      }
    } catch (error) {
      await showErrorBox("Could not add the profile", String(error?.message ?? error));
    }
  }

  async removeProfile(provider) {
    try {
      const label = this.providers.find((option) => option.provider === provider)?.label ?? provider;
      const active = this.provider === provider;
      const response = await showMessageBox({
        message: `Remove ${label}?`,
        detail: active
          ? "This profile is active. Removing it deletes its section from config.toml " +
            "and switches Codex back to the OpenAI provider."
          : "This deletes the profile's section from config.toml.",
        buttons: ["Cancel", "Remove"],
        defaultId: 0,
        cancelId: 0,
        destructiveId: 1,
      });
      if (response !== 1) {
        return;
      }
      if (active) {
        mod.writeProvider(mod.OPENAI_PROVIDER);
        this.provider = mod.OPENAI_PROVIDER;
      }
      mod.removeProvider(provider);
      log(`removed profile ${provider}`);
      this.syncProviders();
      if (active) {
        await this.session?.broadcast(
          `${mod.activeProviderSyncScript(mod.OPENAI_PROVIDER)};` +
            `globalThis.__codexSetActiveProfile?.(${JSON.stringify(mod.OPENAI_PROVIDER)})`,
        );
      }
      await this.broadcastSidebar();
      if (active) {
        this.refreshBudget();
        await this.#applySwitch();
      }
    } catch (error) {
      await showErrorBox("Could not remove the profile", String(error?.message ?? error));
    }
  }

  refreshBudget() {
    this.#usageFetchedAt = 0;
    this.#liveUsageAt = 0;
    void this.pollBudget();
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
    if (rows == null || this.#activeProvider() !== mod.OPENAI_PROVIDER) {
      return;
    }
    if (this.#liveUsageAt === 0) {
      log("usage now follows the renderer's reports");
    }
    this.#liveUsageAt = Date.now();
    this.#usagePayload = { rows };
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
      if (provider === mod.OPENAI_PROVIDER) {
        if (switched) {
          this.#usagePayload = null;
          this.#usageFetchedAt = 0;
          this.#liveUsageAt = 0;
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
          const liveRows = this.#usagePayload?.rows;
          const trustLive =
            liveRows != null && Date.now() - this.#liveUsageAt < mod.LIVE_USAGE_TRUST_MS;
          if (trustLive) {
            // The renderer's reports are fresher than this poll, and a failure
            // here does not make the live numbers any less valid.
            if (outcome.error != null) {
              log(`usage poll failed: ${outcome.error}`);
            }
          } else if (outcome.error != null) {
            // Keep the last known rows and say why they may be stale.
            log(`usage poll failed: ${outcome.error}`);
            this.#usagePayload = { rows: liveRows ?? [], error: outcome.error };
          } else if (rows != null) {
            this.#usagePayload = { rows };
          } else if (this.#usagePayload == null || this.#usagePayload.error != null) {
            // No rate limits at all, as with an API-key login: nothing to show.
            this.#usagePayload = null;
          }
        }
        this.budgetPayload = this.#usagePayload;
      } else if (source == null) {
        this.budgetPayload = { rows: [], notice: NO_USAGE_NOTICE };
      } else {
        const fetched = await mod.fetchBudget(source);
        if (fetched.unsupported) {
          this.budgetPayload = { rows: [], notice: NO_USAGE_NOTICE };
        } else if (fetched.error == null) {
          this.budgetPayload = { rows: mod.budgetRows(fetched.budget) };
        } else {
          log(`budget poll failed: ${fetched.error}`);
          const previous = switched ? [] : this.budgetPayload?.rows ?? [];
          this.budgetPayload = { rows: previous, error: fetched.error };
        }
      }
      await this.broadcastBudget();
    } finally {
      this.#polling = false;
    }
  }
}

// Exiting is how the host picks up new sources: launchd starts it again from
// the updated checkout, and the new instance reloads Codex's pages so they
// pick up the rebuilt bundles.
let restartWhenCodexQuits = false;

function restartHost(reason) {
  log(`${reason}; exiting so the launch agent restarts the host`);
  shutdown("SIGTERM");
}

let lastRemoteError = null;

async function checkForUpdate() {
  const status = await runPatcher(["--update-status"], 120000);
  let info;
  try {
    info = JSON.parse(status.stdout);
  } catch {
    log(`update check failed: ${(status.stderr || status.stdout).trim()}`);
    return;
  }
  if (!info.remote_reachable) {
    // Logged on every change of reason, not every five minutes.
    if (info.remote_error !== lastRemoteError) {
      lastRemoteError = info.remote_error;
      log(`update check: remote unreachable (${info.remote_error ?? "unknown reason"})`);
    }
    return;
  }
  if (lastRemoteError !== null) {
    lastRemoteError = null;
    log("update check: remote reachable again");
  }
  if (!info.automatic_updates || !info.update_available) {
    return;
  }
  log(`release ${info.remote_release} is available; updating from ${info.local_release ?? "an untagged build"}`);
  const pulled = await runPatcher(["--pull"], 120000);
  let result;
  try {
    result = JSON.parse(pulled.stdout);
  } catch {
    result = { error: (pulled.stderr || pulled.stdout).trim() || "git pull failed" };
  }
  if (result.error) {
    log(`update failed: ${result.error}`);
    return;
  }
  if (!result.moved) {
    return;
  }
  try {
    await refreshRendererCache();
  } catch (error) {
    log(`update failed: ${error.message}`);
    return;
  }
  if (codexPids().length === 0) {
    restartHost(`Codex Mod ${result.describe} installed`);
    return;
  }
  const response = await showMessageBox({
    message: `Codex Mod ${result.describe} installed`,
    detail:
      "Reload the Codex windows to apply the update. Running threads continue; " +
      "an unsent draft in the composer is lost.",
    buttons: ["Later", "Reload"],
    defaultId: 1,
    cancelId: 0,
  });
  if (response === 1) {
    restartHost(`Codex Mod ${result.describe} installed`);
  } else {
    restartWhenCodexQuits = true;
  }
}

async function waitForDevTools() {
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) {
        return;
      }
    } catch {
      // Codex is not running with the switch yet.
    }
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

async function relaunchIfUnflagged() {
  const unflagged = codexPids().filter((pid) => !processArguments(pid).includes("--remote-debugging-port="));
  if (unflagged.length === 0) {
    return;
  }
  log(`relaunching unflagged Codex ${unflagged.join(", ")} found at host start`);
  await relaunchCodex();
}

async function main() {
  // The watcher goes first so a Codex launched during the slower startup
  // steps below is caught and relaunched instead of coming up unpatched.
  startLaunchWatcher();
  log(`loaded ${await loadShellEnvironment()} variable(s) from the login shell`);
  await ensureRendererCache();
  const state = new ModState();
  modState = state;
  setInterval(() => void checkForUpdate().catch((error) => log(error.message)), UPDATE_CHECK_INTERVAL_MS);
  setInterval(() => {
    const providersChanged = state.syncProviders();
    if (providersChanged) {
      log(`profiles now: ${state.providers.map((option) => option.label).join(", ")}`);
    }
    if (state.syncAccounts() || providersChanged) {
      void state.broadcastSidebar();
    }
  }, mod.AUTH_SYNC_INTERVAL_MS);
  setInterval(() => void state.pollBudget(), mod.BUDGET_POLL_INTERVAL_MS);
  watchOpenRollouts({
    pids: appServerPids,
    onFailure: (failure) => void state.offerReasoningStrip(failure),
    log,
  });
  if (codexPids().length === 0) {
    await repairRolloutsWhenIdle();
  }
  void relaunchIfUnflagged();

  for (;;) {
    await waitForDevTools();
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
    log("Codex went away; waiting for the next launch");
    if (restartWhenCodexQuits) {
      restartHost("applying the postponed update");
    } else {
      void repairRolloutsWhenIdle();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
