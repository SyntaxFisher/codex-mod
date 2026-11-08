import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import {
  DEVELOPMENT_VARIABLE,
  RELEASES_DIR,
  agentConfiguration,
  installMode,
  newerRelease,
  parseVersion,
  plistXml,
  readPlist,
  sourceRelease,
} from "../scripts/installation.mjs";

describe("versions", () => {
  test("release tags parse with or without a v prefix", () => {
    assert.deepEqual(parseVersion("5.0.0"), [5, 0, 0]);
    assert.deepEqual(parseVersion("v10.2.3"), [10, 2, 3]);
    assert.equal(parseVersion("5.0"), null);
    assert.equal(parseVersion("5.0.0-rc1"), null);
  });

  test("newer releases compare numerically", () => {
    assert.ok(newerRelease("4.10.0", "4.9.9"));
    assert.ok(newerRelease("5.0.0", null));
    assert.ok(!newerRelease("4.3.4", "4.3.4"));
    assert.ok(!newerRelease("4.3.3", "4.3.4"));
    assert.ok(!newerRelease("garbage", "4.3.4"));
  });

  test("a release archive names its version in VERSION", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mod-release-"));
    try {
      fs.writeFileSync(path.join(root, "VERSION"), "5.1.2\n");
      assert.deepEqual(sourceRelease(root), { version: "5.1.2", describe: "5.1.2", head: null });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("install modes", () => {
  test("a release below the release directory is a release install", () => {
    assert.equal(installMode(path.join(RELEASES_DIR, "5.0.0"), {}), "release");
  });

  test("a checkout is a development install only with the marker", () => {
    const checkout = path.join(os.tmpdir(), "codex-mod");
    assert.equal(installMode(checkout, { [DEVELOPMENT_VARIABLE]: "1" }), "development");
    assert.equal(installMode(checkout, {}), "legacy-checkout");
  });
});

describe("launch agent", () => {
  test("the plist round-trips through plutil", () => {
    const configuration = agentConfiguration({
      node: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
      mode: "release",
      codexHome: "/tmp/a home & <more>",
    });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codex-mod-plist-")), "agent.plist");
    try {
      fs.writeFileSync(file, plistXml(configuration));
      assert.equal(spawnSync("/usr/bin/plutil", ["-lint", file]).status, 0);
      assert.deepEqual(readPlist(file), configuration);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  test("a release agent runs the host through the current link", () => {
    const configuration = agentConfiguration({ node: "/usr/local/bin/node", mode: "release", codexHome: null });
    assert.match(configuration.ProgramArguments[1], /codex-mod\/current\/scripts\/codex_mod_host\.mjs$/);
    assert.equal(configuration.EnvironmentVariables[DEVELOPMENT_VARIABLE], undefined);
    assert.equal(configuration.EnvironmentVariables.CODEX_HOME, undefined);
  });

  test("a development agent carries the marker", () => {
    const configuration = agentConfiguration({ node: "/usr/local/bin/node", mode: "development", codexHome: null });
    assert.equal(configuration.EnvironmentVariables[DEVELOPMENT_VARIABLE], "1");
  });
});

describe("retired checkouts", () => {
  // Runs in a child with its own HOME, since the release install lives there.
  function retire(home, checkout) {
    const script =
      'const m = await import("./scripts/installation.mjs");' +
      `m.retireCheckout(${JSON.stringify(checkout)});` +
      "m.removeRetiredCheckout((line) => console.log(line));";
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.dirname(path.dirname(new URL(import.meta.url).pathname)),
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }

  function clone(root, name) {
    const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (!fs.existsSync(path.join(root, "origin.git"))) {
      git("init", "-q", "--bare", "-b", "main", "origin.git");
      git("clone", "-q", "origin.git", "seed");
      fs.mkdirSync(path.join(root, "seed/scripts"));
      fs.writeFileSync(path.join(root, "seed/scripts/codex_mod_host.mjs"), "");
      spawnSync("git", ["add", "-A"], { cwd: path.join(root, "seed") });
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: path.join(root, "seed") });
      spawnSync("git", ["push", "-q", "origin", "main"], { cwd: path.join(root, "seed") });
    }
    git("clone", "-q", "origin.git", name);
    return path.join(root, name);
  }

  test("a clean checkout is removed, one with work of its own is kept", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mod-retire-"));
    try {
      const home = path.join(root, "home");
      fs.mkdirSync(home);
      const clean = clone(root, "clean");
      fs.mkdirSync(path.join(clean, "build"));
      fs.writeFileSync(path.join(clean, ".git/info/exclude"), "build/\n");
      assert.match(retire(home, clean), /removed the checkout/);
      assert.ok(!fs.existsSync(clean));

      const dirty = clone(root, "dirty");
      fs.writeFileSync(path.join(dirty, "notes.txt"), "mine");
      assert.match(retire(home, dirty), /kept the checkout .* uncommitted changes/);
      assert.ok(fs.existsSync(dirty));

      const ahead = clone(root, "ahead");
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "local"], { cwd: ahead });
      assert.match(retire(home, ahead), /kept the checkout .* never pushed/);
      assert.ok(fs.existsSync(ahead));

      const branched = clone(root, "branched");
      spawnSync("git", ["switch", "-q", "-c", "feature"], { cwd: branched });
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "wip"], { cwd: branched });
      spawnSync("git", ["switch", "-q", "main"], { cwd: branched });
      assert.match(retire(home, branched), /kept the checkout .* never pushed/);

      const shared = clone(root, "shared");
      spawnSync("git", ["worktree", "add", "-q", "--detach", path.join(root, "shared-tree")], { cwd: shared });
      assert.match(retire(home, shared), /kept the checkout .* other worktrees/);
      assert.ok(!fs.existsSync(path.join(home, "Library/Application Support/codex-mod/retired-checkout")));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
