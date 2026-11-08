#!/usr/bin/env node
// Installs, removes and maintains Codex Mod. The installer and the Makefile
// call it with the Node.js that Codex ships, and the host runs its cache
// build in a separate process through it.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  INSTALL_ROOT,
  SOURCE_ROOT,
  agentConfiguration,
  agentDisabled,
  agentInstalled,
  agentRunning,
  disableAgent,
  enableAgent,
  ensureAgentStarted,
  installAgent,
  installedCodexHome,
  installedLegacyCheckout,
  isReleaseInstall,
  pruneReleases,
  resolveNode,
  retireCheckout,
  sourceRelease,
  stopAgent,
  LABEL,
  uninstallAgents,
} from "./installation.mjs";
import { buildRendererCache, defaultAsar, dryRun, log, restorePatchedAsar } from "./patcher.mjs";

const USAGE = `usage: codex_mod.mjs <command> [options]

commands:
  install          build the renderer cache and install the launch agent that
                   runs the host; from a checkout, the agent runs the checkout
  uninstall        remove the launch agent, the cache and the release install
  build-cache      build the renderer cache for the installed Codex build
  dry-run          check the patches against the installed Codex build
  on | off         turn the mod on or off without uninstalling it
  status           print whether the mod is installed and running
  codex-home       print the CODEX_HOME the installed agent runs with
  repair-rollouts  renumber rollout segments whose ordinals regress

options:
  --asar PATH            Codex app.asar (default: the installed Codex)
  --renderer-cache DIR   cache directory (default: in CODEX_HOME)
  --app PATH             Codex application to restart for off
  --node PATH            Node.js for the host (default: the one Codex ships)
  --dry-run              with repair-rollouts: only report
`;

const CODEX_BUNDLE_ID = "com.openai.codex";
const DEBUGGING_SWITCH = "--remote-debugging-port=";

// Later commands work in the home the installed agent runs with, so a mod
// installed for a separate Codex home stays there without repeating it.
if (!process.env.CODEX_HOME) {
  const installed = installedCodexHome();
  if (installed) {
    process.env.CODEX_HOME = installed;
  }
}
const CODEX_HOME = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
const DEFAULT_CACHE_DIR = path.join(CODEX_HOME, ".codex-mod-renderer-cache");
// {"automaticUpdates": false} turns the host's release check off.
const CONFIG_PATH = path.join(CODEX_HOME, ".codex-mod-config.json");
// The CLI wrapper the host launches Codex with while browser tools use the
// ChatGPT login.
const CLI_WRAPPER_DIR = path.join(CODEX_HOME, ".codex-mod-cli");
// Releases before 2.0.0 recorded their app.asar backup in a state file,
// installed an npm dependency into the checkout, and talked to their launch
// agent through marker files.
const LEGACY_PATHS = [
  path.join(CODEX_HOME, ".codex-mod-state.json"),
  path.join(SOURCE_ROOT, "node_modules"),
  ...[
    ".codex-mod-check-request",
    ".codex-mod-update-request",
    ".codex-mod-uninstall-request",
    ".codex-mod-uninstalled",
    ".codex-mod-probe-request",
    ".codex-mod-probe.json",
    ".codex-mod-progress.json",
  ].map((name) => path.join(CODEX_HOME, name)),
];

function removePaths(paths) {
  for (const file of paths) {
    fs.rmSync(file, { recursive: true, force: true });
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requireAsar(asar) {
  if (!fs.existsSync(asar)) {
    throw new Error(`missing ASAR: ${asar}`);
  }
  return asar;
}

/** Restore a patched app.asar, build the cache, then start the host.
 *
 * Installing the agent ends with launchd stopping the agent of a release
 * before 2.0.0, and with it the process running this install when that agent
 * started it, which is why it is the last step. */
async function install({ asar, cacheDir, node, legacyCheckout }) {
  restorePatchedAsar(requireAsar(asar), CODEX_HOME);
  buildRendererCache(asar, cacheDir);
  removePaths(LEGACY_PATHS);
  const mode = isReleaseInstall() ? "release" : legacyCheckout ? "legacy-checkout" : "development";
  if (mode === "release") {
    pruneReleases([path.basename(fs.realpathSync(SOURCE_ROOT))]);
    // The installer also replaces a checkout install an earlier release set
    // up; the release's host removes that checkout once it runs.
    const checkout = installedLegacyCheckout();
    if (checkout != null) {
      retireCheckout(checkout);
    }
  }
  await installAgent(agentConfiguration({ node: resolveNode(node), mode }), (line) => log(line));
  if (mode === "development") {
    log("the host runs from this checkout and does not update itself");
  }
}

async function uninstall({ asar, cacheDir }) {
  await uninstallAgents((line) => log(line));
  if (fs.existsSync(asar)) {
    restorePatchedAsar(asar, CODEX_HOME);
  }
  removePaths([cacheDir, ...LEGACY_PATHS, CONFIG_PATH, CLI_WRAPPER_DIR, INSTALL_ROOT]);
  log("uninstalled; Codex keeps running without the mod");
}

/** Running Codex main processes of `app` with their arguments. */
function codexProcesses(app) {
  const executable = path.join(app, "Contents/MacOS/");
  const output = spawnSync("/bin/ps", ["-axo", "pid=,args="], { encoding: "utf8" }).stdout ?? "";
  return output
    .split("\n")
    .map((line) => line.trim().match(/^(\d+) (.*)$/))
    .filter((match) => match != null && match[2].startsWith(executable) && !match[2].includes("--type="))
    .map((match) => ({ pid: Number(match[1]), args: match[2] }));
}

/** Restart a Codex that runs with the mod's debugging switch, without it. */
async function relaunchCodexWithoutMod(app) {
  if (!codexProcesses(app).some((process) => process.args.includes(DEBUGGING_SWITCH))) {
    return;
  }
  log("restarting Codex without the mod; running chats stop");
  spawnSync("/usr/bin/osascript", ["-e", `tell application id "${CODEX_BUNDLE_ID}" to quit`]);
  const deadline = Date.now() + 30000;
  while (codexProcesses(app).length > 0 && Date.now() < deadline) {
    await sleep(500);
  }
  if (codexProcesses(app).length > 0) {
    throw new Error("Codex did not quit; quit it and open it again to run it without the mod");
  }
  const home = installedCodexHome();
  spawnSync("/usr/bin/open", [...(home ? ["--env", `CODEX_HOME=${home}`] : []), app], { stdio: "inherit" });
}

function requireInstalled() {
  if (!agentInstalled()) {
    throw new Error("the mod is not installed");
  }
}

/** Turn the mod off without uninstalling it.
 *
 * The agent stays installed but disabled, so it does not start at the next
 * login either, and Codex runs stock. The renderer cache and the saved
 * account logins are kept for `on`. */
async function off(app) {
  requireInstalled();
  disableAgent();
  await stopAgent(LABEL, (line) => log(line));
  await relaunchCodexWithoutMod(app);
  log("Codex Mod is off; `on` turns it back on");
}

async function on() {
  requireInstalled();
  enableAgent();
  await ensureAgentStarted((line) => log(line));
  log("Codex Mod is on");
}

function status() {
  if (!agentInstalled()) {
    console.log("Codex Mod is not installed");
  } else if (agentDisabled()) {
    console.log("Codex Mod is off");
  } else {
    const release = sourceRelease();
    const name = release.describe ?? release.version ?? "an untagged checkout";
    console.log(`Codex Mod ${name} is on (host ${agentRunning() ? "running" : "not running"})`);
  }
}

function repairRollouts(dryRunOnly) {
  const require = createRequire(import.meta.url);
  const { repairRollouts: repair } = require("./rollout_repair.cjs");
  const repairs = repair({ all: true, dryRun: dryRunOnly, log: (message) => console.log(message) });
  if (repairs.length === 0) {
    console.log("no rollout needs repair");
  } else if (!dryRunOnly) {
    console.log(`${repairs.length} rollout(s) repaired; start Codex to see the restored turns`);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      asar: { type: "string" },
      "renderer-cache": { type: "string" },
      app: { type: "string", default: "/Applications/ChatGPT.app" },
      node: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      // Passed by the patcher shim for the agent of a release before 2.0.0:
      // the checkout's host then moves itself into a release install.
      "legacy-checkout": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const [command] = positionals;
  if (values.help || command == null) {
    process.stdout.write(USAGE);
    return command == null && !values.help ? 2 : 0;
  }
  const asar = path.resolve(values.asar ?? defaultAsar());
  const cacheDir = path.resolve(values["renderer-cache"] ?? DEFAULT_CACHE_DIR);
  switch (command) {
    case "install":
      await install({ asar, cacheDir, node: values.node ?? null, legacyCheckout: values["legacy-checkout"] });
      break;
    case "uninstall":
      await uninstall({ asar, cacheDir });
      break;
    case "build-cache":
      buildRendererCache(requireAsar(asar), cacheDir);
      break;
    case "dry-run":
      dryRun(requireAsar(asar));
      break;
    case "on":
      await on();
      break;
    case "off":
      await off(path.resolve(values.app));
      break;
    case "status":
      status();
      break;
    case "codex-home":
      console.log(installedCodexHome() ?? "");
      break;
    case "repair-rollouts":
      repairRollouts(values["dry-run"]);
      break;
    default:
      process.stderr.write(USAGE);
      return 2;
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    log(`failed: ${error.message}`, { error: true });
    process.exitCode = 1;
  },
);
