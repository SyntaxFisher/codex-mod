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
import time


LABEL = "dev.codex-mod.host"
# Agents installed by releases that patched the application in place.
LEGACY_LABELS = ("dev.codex-mod.watch",)
REPO_ROOT = Path(__file__).resolve().parent.parent
HOST = REPO_ROOT / "scripts/codex_mod_host.mjs"
LAUNCH_AGENTS = Path.home() / "Library/LaunchAgents"
LOG_DIR = Path.home() / "Library/Logs/codex-mod"
BUNDLED_NODE_CANDIDATES = (
    Path("/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"),
    Path("/Applications/Codex.app/Contents/Resources/cua_node/bin/node"),
)
MINIMUM_NODE_MAJOR = 22
CODEX_BUNDLE_ID = "com.openai.codex"
DEBUGGING_SWITCH = "--remote-debugging-port="


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


def requested_codex_home() -> str | None:
    """The CODEX_HOME the install runs with, when it is not Codex's default."""
    value = os.environ.get("CODEX_HOME")
    return str(Path(value).expanduser().resolve()) if value else None


def installed_codex_home() -> str | None:
    """The CODEX_HOME the installed agent runs the host and Codex with."""
    try:
        with plist_path(LABEL).open("rb") as handle:
            configuration = plistlib.load(handle)
    except (OSError, plistlib.InvalidFileException):
        return None
    return configuration.get("EnvironmentVariables", {}).get("CODEX_HOME")


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
    environment = {"PATH": search_path, "CODEX_MOD_PYTHON": sys.executable}
    codex_home = requested_codex_home()
    if codex_home is not None:
        environment["CODEX_HOME"] = codex_home
    return {
        "Label": LABEL,
        "ProgramArguments": [str(node), str(HOST)],
        "RunAtLoad": True,
        # The host exits on purpose to pick up an update and relies on launchd
        # to start it again.
        "KeepAlive": True,
        "ThrottleInterval": 5,
        "WorkingDirectory": str(REPO_ROOT),
        "EnvironmentVariables": environment,
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
    # bootout returns while the service is still being torn down, and a
    # bootstrap of the same label during the teardown fails.
    deadline = time.monotonic() + 15
    while is_loaded(label) and time.monotonic() < deadline:
        time.sleep(0.2)
    print(f"stopped {label}")


def start() -> None:
    for attempt in range(10):
        if attempt:
            time.sleep(1)
        result = run_launchctl("bootstrap", domain(), str(plist_path(LABEL)))
        if result.returncode == 0:
            print(f"started {LABEL}")
            return
    raise RuntimeError(result.stderr.strip() or result.stdout.strip())


def resolve_node(executable: Path | None) -> Path:
    """The Node.js binary the agent runs the host with.

    Codex ships its own Node.js, so by default the host runs on that and needs
    neither a user-installed Node nor a version manager, which launchd could
    not run a shim of anyway. An explicit executable is resolved to the real
    binary behind such a shim.
    """
    if executable is None:
        executable = next(
            (candidate for candidate in BUNDLED_NODE_CANDIDATES if candidate.is_file()),
            None,
        )
    if executable is None:
        found = shutil.which("node")
        if found is None:
            raise RuntimeError("Node.js was not found on PATH")
        executable = Path(found)
    result = subprocess.run(
        [str(executable), "-p", "process.execPath + ' ' + process.versions.node"],
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"{executable} is not a working Node.js executable")
    real_path, version = result.stdout.strip().rsplit(" ", 1)
    if int(version.split(".")[0]) < MINIMUM_NODE_MAJOR:
        raise RuntimeError(
            f"{executable} is Node.js {version}; the host needs {MINIMUM_NODE_MAJOR} or newer"
        )
    return Path(real_path).resolve()


def install(node: Path) -> None:
    """Start the host agent, then retire the agent of an earlier release.

    That earlier agent may be the very process running this install (it
    re-executes the patcher after pulling a release), so it is stopped last:
    everything else has been done by the time launchd ends it.
    """
    stop(LABEL)
    write_plist(node)
    # An agent turned off with `disable` refuses to bootstrap until enabled.
    run_launchctl("enable", service(LABEL))
    start()
    print(f"installed {plist_path(LABEL)}")
    for label in LEGACY_LABELS:
        legacy = plist_path(label)
        if legacy.exists():
            legacy.unlink()
            print(f"removed {legacy}")
        stop(label)


def uninstall() -> None:
    for label in (*LEGACY_LABELS, LABEL):
        stop(label)
        plist = plist_path(label)
        if plist.exists():
            plist.unlink()
            print(f"removed {plist}")


def codex_pids(app: Path) -> dict[int, str]:
    """Running Codex main processes of ``app`` with their arguments."""
    result = subprocess.run(
        ["/bin/ps", "-axo", "pid=,args="], text=True, capture_output=True, check=False
    )
    executable = str(app / "Contents/MacOS/")
    pids = {}
    for line in result.stdout.splitlines():
        pid, _, arguments = line.strip().partition(" ")
        if arguments.startswith(executable) and "--type=" not in arguments:
            pids[int(pid)] = arguments
    return pids


def relaunch_codex_without_mod(app: Path) -> None:
    """Restart a Codex that runs with the mod's debugging switch, without it."""
    if not any(DEBUGGING_SWITCH in arguments for arguments in codex_pids(app).values()):
        return
    print("restarting Codex without the mod; running chats stop")
    subprocess.run(
        ["/usr/bin/osascript", "-e", f'tell application id "{CODEX_BUNDLE_ID}" to quit'],
        capture_output=True,
        check=False,
    )
    deadline = time.monotonic() + 30
    while codex_pids(app) and time.monotonic() < deadline:
        time.sleep(0.5)
    if codex_pids(app):
        raise RuntimeError("Codex did not quit; quit it and open it again to run it without the mod")
    codex_home = installed_codex_home()
    environment = [] if codex_home is None else ["--env", f"CODEX_HOME={codex_home}"]
    subprocess.run(["/usr/bin/open", *environment, str(app)], check=True)


def disable(app: Path) -> None:
    """Turn the mod off without uninstalling it.

    The agent stays installed but disabled, so it does not start at the next
    login either, and Codex runs stock. The renderer cache and the saved
    account logins are kept for `enable`.
    """
    if not plist_path(LABEL).exists():
        raise RuntimeError("the mod is not installed; run make install")
    run_launchctl("disable", service(LABEL))
    stop(LABEL)
    relaunch_codex_without_mod(app)
    print("Codex Mod is off; make on turns it back on")


def enable() -> None:
    """Turn the mod back on; the host relaunches a running Codex with it."""
    if not plist_path(LABEL).exists():
        raise RuntimeError("the mod is not installed; run make install")
    run_launchctl("enable", service(LABEL))
    if not is_loaded(LABEL):
        start()
    print("Codex Mod is on")


def is_disabled(label: str) -> bool:
    result = run_launchctl("print-disabled", domain())
    return f'"{label}" => disabled' in result.stdout or f'"{label}" => true' in result.stdout


def status() -> None:
    if not plist_path(LABEL).exists():
        print("Codex Mod is not installed")
    elif is_disabled(LABEL):
        print("Codex Mod is off")
    else:
        print(f"Codex Mod is on (host {'running' if is_loaded(LABEL) else 'not running'})")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "command",
        choices=("install", "uninstall", "enable", "disable", "status", "codex-home"),
    )
    parser.add_argument(
        "--app",
        type=Path,
        default=Path("/Applications/ChatGPT.app"),
        help="Codex application to restart when the mod is turned off",
    )
    parser.add_argument(
        "--node",
        type=Path,
        help="Node.js executable for the host; defaults to the one Codex ships",
    )
    args = parser.parse_args()

    try:
        if args.command == "install":
            install(resolve_node(args.node))
        elif args.command == "enable":
            enable()
        elif args.command == "disable":
            disable(args.app)
        elif args.command == "status":
            status()
        elif args.command == "codex-home":
            print(installed_codex_home() or "")
        else:
            uninstall()
        return 0
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"[launch-agent] {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
