#!/usr/bin/env node
// Checks a built release archive the way a release install runs it: unpacked
// below releases/ and started through the `current` link, with the archive's
// own scripts. The Office bridge has to answer there, and where Codex is
// installed, Codex's app-server started through the CLI wrapper has to list
// the bridge's tools.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HELP = `Usage: node dev/check_release.mjs <archive>

Unpacks a release archive built by dev/build_release.mjs into a temporary
release install and checks that the Office bridge starts from it through the
\`current\` link. With Codex installed, it also starts Codex's app-server
through the CLI wrapper and checks that the bridge's tools reach it.
Exits non-zero when a check fails.`;

const APP_SERVER_TIMEOUT_MS = 60000;
const BRIDGE_TOOLS = ["execute_document_command", "get_document_tool_schemas", "list_document_sessions"];

function fail(message) {
  console.error(`release check failed: ${message}`);
  process.exit(1);
}

function unpack(archive, root) {
  const releases = path.join(root, "releases");
  fs.mkdirSync(releases, { recursive: true });
  const result = spawnSync("tar", ["-xzf", archive, "-C", releases], { encoding: "utf8" });
  if (result.status !== 0) {
    fail(`could not unpack ${archive}: ${result.stderr.trim()}`);
  }
  const [release, ...extra] = fs.readdirSync(releases);
  if (release == null || extra.length > 0) {
    fail(`${archive} does not hold exactly one release directory`);
  }
  const current = path.join(root, "current");
  fs.symlinkSync(path.join(releases, release), current);
  return current;
}

// The tools Codex's app-server lists for the bridge, polled until the bridge
// has started or the time is up.
function appServerBridgeTools(wrapper, codexHome) {
  return new Promise((resolve) => {
    const child = spawn(wrapper, ["app-server"], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    let buffer = "";
    let nextId = 1;
    let poll = null;
    const finish = (tools) => {
      clearTimeout(timer);
      clearInterval(poll);
      child.kill();
      resolve(tools);
    };
    const timer = setTimeout(() => finish(null), APP_SERVER_TIMEOUT_MS);
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on("error", () => finish(null));
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const server = message.result?.data?.find?.((entry) => entry.name === "codex_mod_office");
        const tools = Object.keys(server?.tools ?? {}).sort();
        if (tools.length > 0) {
          finish(tools);
        }
      }
    });
    send({ id: nextId++, method: "initialize", params: { clientInfo: { name: "codex-mod-release-check", version: "1" } } });
    send({ method: "initialized" });
    poll = setInterval(() => send({ id: nextId++, method: "mcpServerStatus/list", params: { limit: 100 } }), 1000);
  });
}

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }
  if (argv.length !== 1) {
    console.error(HELP);
    process.exit(2);
  }
  const archive = path.resolve(argv[0]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mod-release-check-"));
  try {
    const current = unpack(archive, root);
    const installation = await import(pathToFileURL(path.join(current, "scripts/installation.mjs")).href);
    const { codexBinary } = createRequire(import.meta.url)(path.join(current, "scripts/profile_switcher.cjs"));
    const codexHome = path.join(root, "codex-home");
    fs.mkdirSync(codexHome);
    fs.writeFileSync(path.join(codexHome, "config.toml"), "");
    const bridge = {
      node: process.execPath,
      script: path.join(current, "scripts/office_bridge.mjs"),
      codexHome,
    };

    const problem = installation.probeOfficeBridge(bridge);
    if (problem != null) {
      fail(`the Office bridge does not start through the current link: ${problem}`);
    }
    console.log("ok: the Office bridge answers through the current link");

    const cli = codexBinary();
    if (cli == null) {
      console.log("skipped: no Codex installed, so the app-server check did not run");
      return;
    }
    const wrapper = path.join(root, "codex");
    fs.writeFileSync(wrapper, installation.cliWrapperScript({ cli, officeBridge: bridge }), { mode: 0o755 });
    const tools = await appServerBridgeTools(wrapper, codexHome);
    if (tools == null || tools.join() !== BRIDGE_TOOLS.join()) {
      fail(`Codex's app-server lists ${tools == null ? "no bridge tools" : tools.join(", ")} for the Office bridge`);
    }
    console.log("ok: Codex's app-server lists the Office bridge's tools");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

await main(process.argv.slice(2));
