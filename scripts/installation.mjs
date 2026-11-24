// Where Codex Mod is installed and how it gets there: the release it runs,
// the launch agent that keeps the host running, and the downloads that
// install and update a release.
//
// A release install lives under INSTALL_ROOT: each release unpacked into
// releases/<version>, with the `current` link naming the one the launch agent
// runs. A development checkout runs the host from the checkout itself and is
// never updated automatically. Checkouts installed by releases before 5.0.0
// carry no development marker in their agent; their host moves itself into a
// release install.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REPOSITORY = "SyntaxFisher/codex-mod";
export const RELEASES_URL = (process.env.CODEX_MOD_RELEASES_URL || `https://github.com/${REPOSITORY}/releases`).replace(
  /\/+$/,
  "",
);
export const INSTALL_ROOT = path.join(os.homedir(), "Library/Application Support/codex-mod");
export const RELEASES_DIR = path.join(INSTALL_ROOT, "releases");
export const CURRENT_LINK = path.join(INSTALL_ROOT, "current");
// Names the checkout a migration replaced, for the release's host to remove.
const RETIRED_CHECKOUT_FILE = path.join(INSTALL_ROOT, "retired-checkout");

export const LABEL = "dev.codex-mod.host";
// Agents installed by releases that patched the application in place.
export const LEGACY_LABELS = ["dev.codex-mod.watch"];
const LAUNCH_AGENTS = path.join(os.homedir(), "Library/LaunchAgents");
export const LOG_DIR = path.join(os.homedir(), "Library/Logs/codex-mod");
const BUNDLED_NODE_CANDIDATES = [
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
  "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
];
const MINIMUM_NODE_MAJOR = 22;
// Set in the environment of an agent that runs a development checkout.
export const DEVELOPMENT_VARIABLE = "CODEX_MOD_DEVELOPMENT";

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;
const ARCHIVE_RE = /^codex-mod-\d+\.\d+\.\d+\.tar\.gz$/;
const APP_VERSION_RE = /^\d+(\.\d+)*$/;

export function parseVersion(tag) {
  const match = VERSION_RE.exec(String(tag ?? "").trim());
  return match == null ? null : match.slice(1).map(Number);
}

export function newerRelease(candidate, baseline) {
  const parsed = parseVersion(candidate);
  if (parsed == null) {
    return false;
  }
  const base = parseVersion(baseline);
  if (base == null) {
    return true;
  }
  for (let index = 0; index < 3; index += 1) {
    if (parsed[index] !== base[index]) {
      return parsed[index] > base[index];
    }
  }
  return false;
}

/** Compares dotted numeric versions such as Codex's `26.1111.21308`; missing parts count as 0. */
export function compareAppVersions(left, right) {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
}

/** The CFBundleShortVersionString of a Codex application bundle, or null. */
export function codexAppVersion(bundle) {
  const version = readPlist(path.join(bundle, "Contents/Info.plist"))?.CFBundleShortVersionString;
  return APP_VERSION_RE.test(String(version ?? "")) ? version : null;
}

/** The patches `baseline` applies and `patches` does not; a patch either does not know is not counted. */
export function lostPatches(baseline = {}, patches = {}) {
  return Object.keys(baseline).filter((name) => baseline[name] === true && patches[name] === false);
}

/** What a release loses on a Codex build, judged by its patcher's trial build of the renderer cache.
 *
 * `baseline` holds the patches of the cache being served, null while none is.
 * A patcher that ends with an error cannot build the cache: the release loses
 * everything a patched cache gives, and nothing while none is served. A
 * patcher that did not run to its end, `status` null, says nothing about the
 * release: the result is null and the trial has to be repeated. */
export function trialLosses({ status, patches }, baseline) {
  if (status == null) {
    return null;
  }
  if (status !== 0) {
    return baseline == null ? [] : ["the patched bundles"];
  }
  return lostPatches(baseline ?? {}, patches);
}

/** Whether a release supports the Codex build `appVersion`; an unknown build is not supported. */
export function supportsCodex(info, appVersion) {
  return appVersion != null && compareAppVersions(appVersion, info.minimumCodexVersion) >= 0;
}

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 30000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** The release a source tree holds.
 *
 * A release archive names its version in VERSION; a checkout is described by
 * its newest release tag and `git describe`. */
export function sourceRelease(root = SOURCE_ROOT) {
  try {
    const version = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
    if (parseVersion(version) != null) {
      return { version, describe: version, head: null };
    }
  } catch {
    // A checkout has no VERSION file.
  }
  const tags = (git(root, "tag", "--merged", "HEAD") ?? "").split(/\s+/).filter((tag) => parseVersion(tag));
  const newest = tags.reduce((best, tag) => (newerRelease(tag, best) ? tag : best), null);
  return {
    version: newest,
    describe: git(root, "describe", "--tags", "--always", "--dirty"),
    head: git(root, "rev-parse", "HEAD"),
  };
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function realPath(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/** Whether `root` is a release unpacked into the release install. */
export function isReleaseInstall(root = SOURCE_ROOT) {
  return isInside(realPath(root), realPath(RELEASES_DIR));
}

/** "release", "development", or "legacy-checkout" for a checkout an earlier release installed. */
export function installMode(root = SOURCE_ROOT, environment = process.env) {
  if (isReleaseInstall(root)) {
    return "release";
  }
  return environment[DEVELOPMENT_VARIABLE] === "1" ? "development" : "legacy-checkout";
}

/** The command line tool of the release the launch agent runs next. */
export function currentCli() {
  return isReleaseInstall()
    ? path.join(CURRENT_LINK, "scripts/codex_mod.mjs")
    : path.join(SOURCE_ROOT, "scripts/codex_mod.mjs");
}

/** The Office account bridge of the release the launch agent runs next.
 *
 * Codex keeps running across updates and may start the bridge again from the
 * path it was given, so a release install names it through the `current`
 * link, which survives pruning the release it was written by. */
export function currentOfficeBridge() {
  return isReleaseInstall()
    ? path.join(CURRENT_LINK, "scripts/office_bridge.mjs")
    : path.join(SOURCE_ROOT, "scripts/office_bridge.mjs");
}

export const OFFICE_MCP_SERVER = "codex_mod_office";
const OFFICE_PROBE_TIMEOUT_MS = 10000;

/** Starts the Office bridge the way Codex does and asks for its tools.
 *
 * Returns null when it answers as an MCP server, otherwise why not. The
 * wrapper only hides the connector's own tools behind a bridge that answers,
 * so a bridge that cannot start leaves Codex with the stock connector. */
export function probeOfficeBridge({ node, script, codexHome }) {
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "codex-mod-probe", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];
  const result = spawnSync(node, [script], {
    input: requests.map((request) => `${JSON.stringify(request)}\n`).join(""),
    encoding: "utf8",
    timeout: OFFICE_PROBE_TIMEOUT_MS,
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  if (result.error != null) {
    return result.error.code === "ETIMEDOUT" ? "it did not answer in time" : result.error.message;
  }
  const answers = new Map();
  for (const line of result.stdout.split("\n")) {
    try {
      const message = JSON.parse(line);
      answers.set(message.id, message);
    } catch {
      // Not a message.
    }
  }
  if (answers.get(1)?.result?.serverInfo == null || !Array.isArray(answers.get(2)?.result?.tools)) {
    const detail = crashReason(result.stderr);
    return detail ? `it exited without answering: ${detail}` : "it exited without answering";
  }
  return null;
}

// The line of a Node.js crash report that names the error, which Node prints
// above the stack and its own version line.
function crashReason(stderr) {
  const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /^[A-Za-z]*Error\b/.test(line)) ?? lines.findLast((line) => !/^Node\.js v/.test(line));
}
export const DOCUMENT_CONTROL_CONNECTOR = "connector_openai_codex_document_control";

/** The CLI wrapper Codex is launched with through CODEX_CLI_PATH.
 *
 * `browserToolsLogin` runs the app-server node_repl starts for the browser
 * tools under the OpenAI provider: the tools read the ChatGPT login from it,
 * and an app-server hands the login out only under a provider that requires
 * OpenAI auth. `officeBridge` ({ node, script, codexHome })
 * gives Codex's own app-server the Office account bridge as an MCP server and
 * hides the tools of the Codex Document Control connector it replaces. Codex
 * passes its own `-c` options before `app-server`, so the subcommand can be
 * anywhere. */
export function cliWrapperScript({ cli, browserToolsLogin = false, officeBridge = null }) {
  const quote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
  const toml = (text) => JSON.stringify(String(text));
  const lines = [
    "#!/bin/sh",
    "# Written by Codex Mod; the host rewrites it whenever its settings change.",
    `cli=${quote(cli)}`,
    'parent=$(basename "$(ps -o comm= -p "$PPID")")',
  ];
  if (browserToolsLogin) {
    lines.push(
      'if [ "$1" = app-server ] && [ "$parent" = node_repl ]; then',
      `  exec "$cli" -c ${quote('model_provider="openai"')} "$@"`,
      "fi",
    );
  }
  if (officeBridge != null) {
    const server = `mcp_servers.${OFFICE_MCP_SERVER}`;
    const overrides = [
      `${server}.command=${toml(officeBridge.node)}`,
      `${server}.args=[${toml(officeBridge.script)}]`,
      `${server}.env={CODEX_HOME=${toml(officeBridge.codexHome)}}`,
      // A command waits for the add-in to run it.
      `${server}.tool_timeout_sec=300`,
      // Only the connector's tools: the app itself stays enabled, because
      // Codex's Computer Use settings show its enabled state as the switch
      // for Excel, PowerPoint and Word live control.
      `apps.${DOCUMENT_CONTROL_CONNECTOR}.default_tools_enabled=false`,
    ];
    lines.push(
      'if [ "$parent" != node_repl ]; then',
      '  case " $* " in',
      `    *" app-server "*) exec "$cli" ${overrides.map((option) => `-c ${quote(option)}`).join(" ")} "$@" ;;`,
      "  esac",
      "fi",
    );
  }
  lines.push('exec "$cli" "$@"', "");
  return lines.join("\n");
}

/** The version the `current` link points at, if it points at a release. */
export function currentReleaseVersion() {
  try {
    return sourceRelease(fs.realpathSync(CURRENT_LINK)).version;
  } catch {
    return null;
  }
}

export function releaseDirectory(version) {
  return path.join(RELEASES_DIR, version);
}

function validRelease(info) {
  return (
    info != null &&
    typeof info === "object" &&
    parseVersion(info.version) != null &&
    typeof info.archive === "string" &&
    ARCHIVE_RE.test(info.archive) &&
    typeof info.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(info.sha256) &&
    typeof info.minimumCodexVersion === "string" &&
    APP_VERSION_RE.test(info.minimumCodexVersion)
  );
}

async function download(url, timeoutMs) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "codex-mod" },
  });
  if (!response.ok) {
    throw new Error(`${url} answered HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** The newest published release: its version, archive name, SHA-256 and the oldest Codex build it supports. */
export async function fetchLatestRelease() {
  const data = await download(`${RELEASES_URL}/latest/download/release.json`, 30000);
  let info;
  try {
    info = JSON.parse(data.toString("utf8"));
  } catch {
    throw new Error("the release description is not valid JSON");
  }
  if (!validRelease(info)) {
    throw new Error("the release description is incomplete");
  }
  return info;
}

// Each unpacked release keeps its release description, so a release
// downloaded ahead of the Codex build it needs can be judged offline.
const RELEASE_INFO_FILE = "release.json";

function writeReleaseInfo(target, info) {
  fs.writeFileSync(path.join(target, RELEASE_INFO_FILE), `${JSON.stringify(info, null, 2)}\n`);
}

/** Download, verify and unpack a release into the release install, unless it is there already. */
export async function downloadRelease(info) {
  const target = releaseDirectory(info.version);
  if (sourceRelease(target).version === info.version && fs.existsSync(path.join(target, "scripts/codex_mod_host.mjs"))) {
    writeReleaseInfo(target, info);
    return target;
  }
  const archive = await download(`${RELEASES_URL}/download/${info.version}/${info.archive}`, 120000);
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== info.sha256) {
    throw new Error(`${info.archive} does not match its published SHA-256`);
  }
  fs.mkdirSync(RELEASES_DIR, { recursive: true });
  const staging = fs.mkdtempSync(path.join(RELEASES_DIR, ".download-"));
  try {
    const archivePath = path.join(staging, info.archive);
    fs.writeFileSync(archivePath, archive);
    const unpacked = spawnSync("/usr/bin/tar", ["-xzf", archivePath, "-C", staging], { encoding: "utf8" });
    if (unpacked.status !== 0) {
      throw new Error(`unpacking ${info.archive} failed: ${unpacked.stderr.trim()}`);
    }
    const root = path.join(staging, `codex-mod-${info.version}`);
    if (sourceRelease(root).version !== info.version) {
      throw new Error(`${info.archive} does not hold release ${info.version}`);
    }
    writeReleaseInfo(root, info);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(root, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return target;
}

/** The newest unpacked release newer than `baseline`, or null; with `appVersion`, only one that supports that Codex build. */
export function newestDownloadedRelease(baseline, appVersion = null, directory = RELEASES_DIR) {
  let entries;
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return null;
  }
  let newest = null;
  for (const entry of entries) {
    let info;
    try {
      info = JSON.parse(fs.readFileSync(path.join(directory, entry, RELEASE_INFO_FILE), "utf8"));
    } catch {
      continue;
    }
    if (
      validRelease(info) &&
      info.version === entry &&
      sourceRelease(path.join(directory, entry)).version === info.version &&
      newerRelease(info.version, baseline) &&
      (appVersion == null || supportsCodex(info, appVersion)) &&
      (newest == null || newerRelease(info.version, newest.version))
    ) {
      newest = info;
    }
  }
  return newest;
}

/** Point the `current` link at an unpacked release; the agent runs it from its next start. */
export function activateRelease(version) {
  const link = `${CURRENT_LINK}.${process.pid}.tmp`;
  fs.rmSync(link, { force: true });
  fs.symlinkSync(path.join("releases", version), link);
  fs.renameSync(link, CURRENT_LINK);
}

/** Remove unpacked releases other than those named. */
export function pruneReleases(keep) {
  let entries;
  try {
    entries = fs.readdirSync(RELEASES_DIR);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!keep.includes(entry)) {
      fs.rmSync(path.join(RELEASES_DIR, entry), { recursive: true, force: true });
    }
  }
}

function plistPath(label) {
  return path.join(LAUNCH_AGENTS, `${label}.plist`);
}

function launchDomain() {
  return `gui/${process.getuid()}`;
}

function service(label) {
  return `${launchDomain()}/${label}`;
}

function launchctl(...args) {
  return spawnSync("/bin/launchctl", args, { encoding: "utf8" });
}

function isLoaded(label) {
  return launchctl("print", service(label)).status === 0;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function readPlist(file) {
  const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function escapeXml(text) {
  return String(text).replace(/[&<>"]/g, (character) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[character]};`);
}

function plistValue(value, indent) {
  const pad = "\t".repeat(indent);
  if (typeof value === "boolean") {
    return `${pad}<${value}/>`;
  }
  if (typeof value === "number") {
    return `${pad}<integer>${value}</integer>`;
  }
  if (Array.isArray(value)) {
    return [`${pad}<array>`, ...value.map((item) => plistValue(item, indent + 1)), `${pad}</array>`].join("\n");
  }
  if (typeof value === "object") {
    return [
      `${pad}<dict>`,
      ...Object.entries(value).flatMap(([key, item]) => [
        `${pad}\t<key>${escapeXml(key)}</key>`,
        plistValue(item, indent + 1),
      ]),
      `${pad}</dict>`,
    ].join("\n");
  }
  return `${pad}<string>${escapeXml(value)}</string>`;
}

export function plistXml(value) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistValue(value, 0),
    "</plist>",
    "",
  ].join("\n");
}

/** The CODEX_HOME the installed agent runs the host and Codex with. */
export function installedCodexHome() {
  return readPlist(plistPath(LABEL))?.EnvironmentVariables?.CODEX_HOME ?? null;
}

/** The Node.js binary the agent runs the host with.
 *
 * Codex ships its own Node.js, so by default the host runs on that and needs
 * neither a user-installed Node nor a version manager, which launchd could
 * not run a shim of anyway. An explicit executable is resolved to the real
 * binary behind such a shim. */
export function resolveNode(executable = null) {
  const candidate =
    executable ?? BUNDLED_NODE_CANDIDATES.find((file) => fs.existsSync(file)) ?? process.execPath;
  const result = spawnSync(candidate, ["-p", "process.execPath + ' ' + process.versions.node"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${candidate} is not a working Node.js executable`);
  }
  const [realExecutable, version] = result.stdout.trim().split(/ (?=[^ ]+$)/);
  if (Number(version.split(".")[0]) < MINIMUM_NODE_MAJOR) {
    throw new Error(`${candidate} is Node.js ${version}; the host needs ${MINIMUM_NODE_MAJOR} or newer`);
  }
  return fs.realpathSync(realExecutable);
}

/** The launch agent for a host source: the release install, or a checkout.
 *
 * A release install runs the host through the `current` link, so an update
 * only has to move the link and restart the host. */
export function agentConfiguration({ node, mode, codexHome = process.env.CODEX_HOME }) {
  const root = mode === "release" ? CURRENT_LINK : SOURCE_ROOT;
  // launchd starts agents with a minimal PATH.
  const searchPath = [
    ...new Set([path.dirname(node), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]),
  ].join(":");
  const environment = { PATH: searchPath };
  if (codexHome) {
    environment.CODEX_HOME = path.resolve(codexHome.replace(/^~(?=$|\/)/, os.homedir()));
  }
  if (mode === "development") {
    environment[DEVELOPMENT_VARIABLE] = "1";
  }
  if (process.env.CODEX_MOD_RELEASES_URL) {
    environment.CODEX_MOD_RELEASES_URL = process.env.CODEX_MOD_RELEASES_URL;
  }
  return {
    Label: LABEL,
    ProgramArguments: [node, path.join(root, "scripts/codex_mod_host.mjs")],
    RunAtLoad: true,
    // The host exits on purpose to pick up an update and relies on launchd to
    // start it again.
    KeepAlive: true,
    ThrottleInterval: 5,
    WorkingDirectory: mode === "release" ? INSTALL_ROOT : SOURCE_ROOT,
    EnvironmentVariables: environment,
    StandardOutPath: path.join(LOG_DIR, "host.log"),
    StandardErrorPath: path.join(LOG_DIR, "host-error.log"),
  };
}

export function writeAgent(configuration) {
  fs.mkdirSync(LAUNCH_AGENTS, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const target = plistPath(LABEL);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, plistXml(configuration), { mode: 0o644 });
  fs.renameSync(temporary, target);
}

export async function stopAgent(label, log = console.log) {
  if (!isLoaded(label)) {
    return;
  }
  const result = launchctl("bootout", service(label));
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout).trim());
  }
  // bootout returns while the service is still being torn down, and a
  // bootstrap of the same label during the teardown fails.
  const deadline = Date.now() + 15000;
  while (isLoaded(label) && Date.now() < deadline) {
    await sleep(200);
  }
  log(`stopped ${label}`);
}

async function startAgent(log) {
  let result;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (attempt) {
      await sleep(1000);
    }
    result = launchctl("bootstrap", launchDomain(), plistPath(LABEL));
    if (result.status === 0) {
      log(`started ${LABEL}`);
      return;
    }
  }
  throw new Error((result.stderr || result.stdout).trim());
}

/** Start the host agent, then retire the agent of an earlier release.
 *
 * That earlier agent may be the very process running this install (it
 * re-executes the patcher after pulling a release), so it is stopped last:
 * everything else has been done by the time launchd ends it. */
export async function installAgent(configuration, log = console.log) {
  await stopAgent(LABEL, log);
  writeAgent(configuration);
  // An agent turned off with `off` refuses to bootstrap until enabled.
  launchctl("enable", service(LABEL));
  await startAgent(log);
  log(`installed ${plistPath(LABEL)}`);
  for (const label of LEGACY_LABELS) {
    const legacy = plistPath(label);
    if (fs.existsSync(legacy)) {
      fs.rmSync(legacy, { force: true });
      log(`removed ${legacy}`);
    }
    await stopAgent(label, log);
  }
}

export async function uninstallAgents(log = console.log) {
  for (const label of [...LEGACY_LABELS, LABEL]) {
    await stopAgent(label, log);
    const plist = plistPath(label);
    if (fs.existsSync(plist)) {
      fs.rmSync(plist, { force: true });
      log(`removed ${plist}`);
    }
  }
}

export function agentInstalled() {
  return fs.existsSync(plistPath(LABEL));
}

export function agentRunning() {
  return isLoaded(LABEL);
}

export function agentDisabled() {
  const output = launchctl("print-disabled", launchDomain()).stdout;
  return output.includes(`"${LABEL}" => disabled`) || output.includes(`"${LABEL}" => true`);
}

export function enableAgent() {
  launchctl("enable", service(LABEL));
}

export function disableAgent() {
  launchctl("disable", service(LABEL));
}

export async function ensureAgentStarted(log = console.log) {
  if (!isLoaded(LABEL)) {
    await startAgent(log);
  }
}

/** Reload the agent from its plist in a process that outlives this host.
 *
 * launchd only reads a plist when the agent is bootstrapped, and booting out
 * the agent ends the host that asks for it, so a detached shell does both. */
export function reloadAgentDetached() {
  const plist = plistPath(LABEL);
  const script = [
    `/bin/launchctl bootout ${service(LABEL)} 2>/dev/null`,
    "i=0",
    'while [ "$i" -lt 30 ]; do',
    `  /bin/launchctl bootstrap ${launchDomain()} '${plist.replaceAll("'", "'\\''")}' 2>/dev/null && exit 0`,
    "  i=$((i + 1))",
    "  sleep 1",
    "done",
    "exit 1",
  ].join("\n");
  spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" }).unref();
}

/** The checkout the installed agent runs when an earlier release installed it, otherwise null. */
export function installedLegacyCheckout() {
  const agent = readPlist(plistPath(LABEL));
  const host = agent?.ProgramArguments?.[1];
  if (typeof host !== "string" || agent.EnvironmentVariables?.[DEVELOPMENT_VARIABLE] === "1") {
    return null;
  }
  const checkout = path.dirname(path.dirname(host));
  return isReleaseInstall(checkout) ? null : checkout;
}

/** Have the next host of the release install remove `checkout`. */
export function retireCheckout(checkout) {
  fs.mkdirSync(INSTALL_ROOT, { recursive: true });
  fs.writeFileSync(RETIRED_CHECKOUT_FILE, `${checkout}\n`);
}

// Why a retired checkout stays on disk, or null when it can go: work in it
// that exists nowhere else is never deleted.
function keepCheckoutReason(checkout) {
  if (!fs.existsSync(path.join(checkout, ".git")) || !fs.existsSync(path.join(checkout, "scripts/codex_mod_host.mjs"))) {
    return "it is not a Codex Mod checkout";
  }
  const status = git(checkout, "status", "--porcelain");
  if (status == null) {
    return "its Git state could not be read";
  }
  if (status !== "") {
    return "it has uncommitted changes";
  }
  const unpushed = git(checkout, "rev-list", "--count", "HEAD", "--branches", "--not", "--remotes");
  if (unpushed !== "0") {
    return "it has commits that were never pushed";
  }
  if (git(checkout, "stash", "list") !== "") {
    return "it has stashed changes";
  }
  const worktrees = (git(checkout, "worktree", "list", "--porcelain") ?? "").match(/^worktree /gm) ?? [];
  return worktrees.length === 1 ? null : "other worktrees use it";
}

/** Remove the checkout a migration left behind, unless it holds work of its own. */
export function removeRetiredCheckout(log) {
  let checkout;
  try {
    checkout = fs.readFileSync(RETIRED_CHECKOUT_FILE, "utf8").trim();
  } catch {
    return;
  }
  if (checkout && fs.existsSync(checkout)) {
    const reason = keepCheckoutReason(checkout);
    if (reason == null) {
      fs.rmSync(checkout, { recursive: true, force: true });
      log(`removed the checkout ${checkout}, which the release install replaces`);
    } else {
      log(`kept the checkout ${checkout} because ${reason}; delete it once it is no longer needed`);
    }
  }
  fs.rmSync(RETIRED_CHECKOUT_FILE, { force: true });
}

/** Move a checkout that an earlier release installed into the release install.
 *
 * Downloads the newest release, points the agent at it and reloads the
 * agent, which ends this host; launchd then starts the host from the release,
 * which removes the checkout. */
export async function migrateCheckoutInstall({ node, codexHome }) {
  const release = await fetchLatestRelease();
  await downloadRelease(release);
  activateRelease(release.version);
  retireCheckout(SOURCE_ROOT);
  writeAgent(agentConfiguration({ node, mode: "release", codexHome }));
  reloadAgentDetached();
  return release.version;
}
