#!/usr/bin/env python3
"""Install the launch agent that keeps the Codex mod host running."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile


LABEL = "dev.codex-mod.host"
# Agents installed by releases that patched the application in place.
LEGACY_LABELS = ("dev.codex-mod.watch",)
REPO_ROOT = Path(__file__).resolve().parent.parent
HOST = REPO_ROOT / "scripts/codex_mod_host.mjs"
LAUNCH_AGENTS = Path.home() / "Library/LaunchAgents"
LOG_DIR = Path.home() / "Library/Logs/codex-mod"


def plist_path(label: str) -> Path:
    return LAUNCH_AGENTS / f"{label}.plist"


def domain() -> str:
    return f"gui/{os.getuid()}"


def service(label: str) -> str:
    return f"{domain()}/{label}"


def run_launchctl(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["/bin/launchctl", *args], text=True, capture_output=True)


def is_loaded(label: str) -> bool:
    return run_launchctl("print", service(label)).returncode == 0


def agent_configuration(node: Path) -> dict[str, object]:
    # launchd starts agents with a minimal PATH, so the interpreters the host
    # spawns are pinned to the ones the install ran with.
    search_path = ":".join(
        dict.fromkeys(
            [
                str(node.parent),
                str(Path(sys.executable).parent),
                "/usr/local/bin",
                "/opt/homebrew/bin",
                "/usr/bin",
                "/bin",
                "/usr/sbin",
                "/sbin",
            ]
        )
    )
    return {
        "Label": LABEL,
        "ProgramArguments": [str(node), str(HOST)],
        "RunAtLoad": True,
        # The host exits on purpose to pick up an update and relies on launchd
        # to start it again.
        "KeepAlive": True,
        "ThrottleInterval": 5,
        "WorkingDirectory": str(REPO_ROOT),
        "EnvironmentVariables": {
            "PATH": search_path,
            "CODEX_MOD_PYTHON": sys.executable,
        },
        "StandardOutPath": str(LOG_DIR / "host.log"),
        "StandardErrorPath": str(LOG_DIR / "host-error.log"),
    }


def write_plist(node: Path) -> None:
    LAUNCH_AGENTS.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=LAUNCH_AGENTS, delete=False) as handle:
        temporary_path = Path(handle.name)
        plistlib.dump(agent_configuration(node), handle, sort_keys=False)
    temporary_path.chmod(0o644)
    os.replace(temporary_path, plist_path(LABEL))


def stop(label: str) -> None:
    if not is_loaded(label):
        return
    result = run_launchctl("bootout", service(label))
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    print(f"stopped {label}")


def start() -> None:
    result = run_launchctl("bootstrap", domain(), str(plist_path(LABEL)))
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    print(f"started {LABEL}")


def resolve_node(executable: Path | None) -> Path:
    """The real Node.js binary behind a version manager's shim, which launchd
    could not run without that manager's environment."""
    if executable is None:
        found = shutil.which("node")
        if found is None:
            raise RuntimeError("Node.js was not found on PATH")
        executable = Path(found)
    result = subprocess.run(
        [str(executable), "-p", "process.execPath"], text=True, capture_output=True
    )
    if result.returncode != 0:
        raise RuntimeError(f"{executable} is not a working Node.js executable")
    return Path(result.stdout.strip()).resolve()


def install(node: Path) -> None:
    for label in (*LEGACY_LABELS, LABEL):
        stop(label)
    for label in LEGACY_LABELS:
        legacy = plist_path(label)
        if legacy.exists():
            legacy.unlink()
            print(f"removed {legacy}")
    write_plist(node)
    start()
    print(f"installed {plist_path(LABEL)}")


def uninstall() -> None:
    for label in (*LEGACY_LABELS, LABEL):
        stop(label)
        plist = plist_path(label)
        if plist.exists():
            plist.unlink()
            print(f"removed {plist}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("install", "uninstall"))
    parser.add_argument(
        "--node",
        type=Path,
        help="Node.js executable for the host; defaults to the one on PATH",
    )
    args = parser.parse_args()

    try:
        if args.command == "install":
            install(resolve_node(args.node))
        else:
            uninstall()
        return 0
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"[launch-agent] {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
