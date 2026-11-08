#!/usr/bin/env python3
"""Entry point that checkout installs of earlier releases still call.

Hosts of releases before 5.0.0 run this file after pulling a release, and the
agent of releases before 2.0.0 runs it with ``--if-changed``. It hands their
calls to the Node.js tooling; the host that starts from the checkout
afterwards moves the install into a release install.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

REPO_ROOT = Path(__file__).resolve().parent.parent
CLI = REPO_ROOT / "scripts/codex_mod.mjs"
NODE_CANDIDATES = (
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
    "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
)
VERSION_TAG_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")


def git(*args: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(REPO_ROOT), *args], text=True, capture_output=True, timeout=30
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def checkout_release() -> str | None:
    tags = [tag for tag in (git("tag", "--merged", "HEAD") or "").split() if VERSION_TAG_RE.match(tag)]
    return max(tags, key=lambda tag: tuple(map(int, VERSION_TAG_RE.match(tag).groups())), default=None)


def automatic_updates() -> bool:
    home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    try:
        config = json.loads((home / ".codex-mod-config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return True
    return not isinstance(config, dict) or config.get("automaticUpdates") is not False


def node() -> str:
    found = next((candidate for candidate in NODE_CANDIDATES if Path(candidate).is_file()), None)
    found = found or shutil.which("node")
    if found is None:
        raise SystemExit("[codex-desktop-patch] failed: the Node.js inside Codex was not found")
    return found


def option(args: list[str], name: str) -> list[str]:
    if name in args:
        index = args.index(name)
        if index + 1 < len(args):
            return [name, args[index + 1]]
    return []


def main() -> int:
    args = sys.argv[1:]
    release = checkout_release()
    describe = git("describe", "--tags", "--always", "--dirty")
    # The release check moved into the host; an earlier host that asks still
    # learns which release the checkout holds and applies it.
    if "--update-status" in args:
        print(json.dumps({
            "local_release": release,
            "remote_release": release,
            "remote_reachable": True,
            "remote_error": None,
            "update_available": False,
            "head": git("rev-parse", "HEAD"),
            "describe": describe,
            "automatic_updates": automatic_updates(),
        }))
        return 0
    if "--pull" in args:
        print(json.dumps({"moved": False, "error": None, "release": release, "describe": describe}))
        return 0
    if "--local-release" in args:
        print(json.dumps({"release": release}))
        return 0

    paths = option(args, "--asar") + option(args, "--renderer-cache")
    if "--uninstall" in args:
        command = ["uninstall", *paths]
    elif "--dry-run" in args:
        command = ["dry-run", *option(args, "--asar")]
    elif "--if-changed" in args:
        command = ["install", "--legacy-checkout", *paths]
    else:
        command = ["build-cache", *paths]
    sys.stdout.flush()
    os.execv(node(), [node(), str(CLI), *command])


if __name__ == "__main__":
    raise SystemExit(main())
