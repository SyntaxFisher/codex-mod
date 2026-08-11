#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile


LABEL = "dev.codex-mod.watch"
REPO_ROOT = Path(__file__).resolve().parent.parent
PATCHER = REPO_ROOT / "scripts/patch_codex.py"
LAUNCH_AGENTS = Path.home() / "Library/LaunchAgents"
PLIST_PATH = LAUNCH_AGENTS / f"{LABEL}.plist"
LOG_DIR = Path.home() / "Library/Logs/codex-mod"


def domain() -> str:
    return f"gui/{os.getuid()}"


def service() -> str:
    return f"{domain()}/{LABEL}"


def run_launchctl(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["/bin/launchctl", *args],
        check=check,
        text=True,
        capture_output=True,
    )


def is_loaded() -> bool:
    return run_launchctl("print", service(), check=False).returncode == 0


def agent_configuration(asar: Path, mode: str = "auto") -> dict[str, object]:
    # Re-patching after the ASAR changes is not optional while the mod is
    # installed, so WatchPaths is present in both modes; the mode only decides
    # whether releases are looked for without being asked.
    configuration: dict[str, object] = {
        "Label": LABEL,
        "ProgramArguments": [
            sys.executable,
            str(PATCHER),
            "--asar",
            str(asar),
            "--if-changed",
        ],
        "RunAtLoad": True,
        "WatchPaths": [str(asar)],
        # Low, so a menu-triggered kickstart answers quickly even when
        # another run finished moments earlier.
        "ThrottleInterval": 10,
        "ProcessType": "Background",
        "WorkingDirectory": str(REPO_ROOT),
        "StandardOutPath": str(LOG_DIR / "patch.log"),
        "StandardErrorPath": str(LOG_DIR / "patch-error.log"),
    }
    if mode == "auto":
        # Short, because the interval only asks the remote for its release
        # tags; the patcher exits immediately unless a newer release appeared
        # or the ASAR moved.
        configuration["StartInterval"] = 300
    return configuration


def installed_configuration() -> dict[str, object] | None:
    if not PLIST_PATH.is_file():
        return None
    try:
        with PLIST_PATH.open("rb") as handle:
            return plistlib.load(handle)
    except (OSError, plistlib.InvalidFileException):
        return None


def installed_mode() -> str | None:
    configuration = installed_configuration()
    if configuration is None:
        return None
    return "auto" if "StartInterval" in configuration else "manual"


def write_plist(asar: Path, mode: str) -> None:
    LAUNCH_AGENTS.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=LAUNCH_AGENTS, delete=False) as handle:
        temporary_path = Path(handle.name)
        plistlib.dump(agent_configuration(asar, mode), handle, sort_keys=False)
    temporary_path.chmod(0o644)
    os.replace(temporary_path, PLIST_PATH)


def start() -> None:
    if is_loaded():
        print(f"{LABEL} is already running")
        return
    if not PLIST_PATH.is_file():
        raise RuntimeError(f"LaunchAgent is not installed: {PLIST_PATH}")
    result = run_launchctl("bootstrap", domain(), str(PLIST_PATH), check=False)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    print(f"started {LABEL}")


def stop() -> None:
    if not is_loaded():
        print(f"{LABEL} is already stopped")
        return
    result = run_launchctl("bootout", service(), check=False)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    print(f"stopped {LABEL}")


def install(asar: Path, mode: str) -> None:
    if is_loaded():
        stop()
    write_plist(asar, mode)
    start()
    print(f"installed {PLIST_PATH} ({mode} mode)")


def uninstall() -> None:
    if is_loaded():
        stop()
    if PLIST_PATH.exists():
        PLIST_PATH.unlink()
        print(f"removed {PLIST_PATH}")
    else:
        print(f"LaunchAgent is not installed: {PLIST_PATH}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("install", "uninstall"))
    parser.add_argument(
        "--asar",
        type=Path,
        default=Path("/Applications/ChatGPT.app/Contents/Resources/app.asar"),
    )
    parser.add_argument(
        "--mode",
        choices=("auto", "manual"),
        default=None,
        help="auto additionally checks the remote for new release tags every "
        "five minutes; both modes re-patch when the ASAR changes. Defaults to "
        "the installed mode, or auto on a fresh install.",
    )
    args = parser.parse_args()

    try:
        if args.command == "install":
            install(
                args.asar.expanduser().resolve(),
                args.mode or installed_mode() or "auto",
            )
        else:
            uninstall()
        return 0
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"[launch-agent] {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
