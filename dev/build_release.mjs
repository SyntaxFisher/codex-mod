#!/usr/bin/env node
// Builds the files a release publishes:
//
//   codex-mod-<version>.tar.gz  the host, the tooling and a universal launch watcher
//   release.json                version, archive name and SHA-256 the installs check
//   install.sh                  the installer the README's one-liner runs
//
//   node dev/build_release.mjs <version> [out-dir]
//
// The release workflow runs it for every release tag; run it locally to try
// an install from a local server through CODEX_MOD_RELEASES_URL.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILES = [
  "README.md",
  "scripts/codex_mod.mjs",
  "scripts/codex_mod_host.mjs",
  "scripts/installation.mjs",
  "scripts/patcher.mjs",
  "scripts/profile_switcher.cjs",
  "scripts/rollout_repair.cjs",
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout;
}

function main() {
  const [version, outArgument = "dist"] = process.argv.slice(2);
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    throw new Error("usage: build_release.mjs <version> [out-dir]");
  }
  const out = path.resolve(outArgument);
  const name = `codex-mod-${version}`;
  const archive = `${name}.tar.gz`;
  fs.rmSync(out, { recursive: true, force: true });
  const root = path.join(out, "staging", name);
  fs.mkdirSync(path.join(root, "build"), { recursive: true });

  for (const file of FILES) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, file), path.join(root, file));
    fs.chmodSync(path.join(root, file), 0o644);
  }
  fs.writeFileSync(path.join(root, "VERSION"), `${version}\n`);

  // Installs download the watcher instead of compiling it, so it is built
  // for both architectures. The linker signs it ad hoc, which is all a
  // binary needs that was not downloaded through a browser.
  const watcher = path.join(root, "build/launch-watcher");
  run("clang", [
    "-arch", "arm64",
    "-arch", "x86_64",
    "-mmacosx-version-min=12.0",
    "-fobjc-arc",
    "-framework", "AppKit",
    "-O2",
    "-o", watcher,
    path.join(REPO_ROOT, "scripts/launch_watcher.m"),
  ]);
  run("/usr/bin/codesign", ["--force", "--sign", "-", watcher]);

  run(
    "/usr/bin/tar",
    [
      "--no-mac-metadata",
      "--no-xattrs",
      "--uid", "0",
      "--gid", "0",
      "--uname", "",
      "--gname", "",
      "-czf", path.join(out, archive),
      "-C", path.dirname(root),
      name,
    ],
    { env: { ...process.env, COPYFILE_DISABLE: "1" } },
  );
  fs.rmSync(path.join(out, "staging"), { recursive: true, force: true });

  const sha256 = createHash("sha256").update(fs.readFileSync(path.join(out, archive))).digest("hex");
  fs.writeFileSync(path.join(out, "release.json"), `${JSON.stringify({ version, archive, sha256 }, null, 2)}\n`);
  fs.copyFileSync(path.join(REPO_ROOT, "install.sh"), path.join(out, "install.sh"));
  console.log(`built ${archive} (${sha256}) in ${out}`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
