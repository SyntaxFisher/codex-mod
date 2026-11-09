#!/usr/bin/env python3
"""Watch for new Codex desktop releases and check the mod against them.

Development tooling for the machine that maintains the mod; nothing here is
part of an install. Everything it keeps lives under ``STATE_DIR``, outside the
repository: archived builds, downloads, reports, screenshots and videos.

    check [--trigger]  compare the appcast and the installed build; with
                       --trigger, start the agent task in a new T3 thread
    install            download, verify and install the newest release
    verify             test the installed build with and without the mod
    status             print the state as JSON
    install-agent      run ``check --trigger`` every hour from launchd

The agent task's instructions are specific to the maintainer's machine and
live in ``TASK_FILE``, outside the repository.
"""
from __future__ import annotations

import argparse
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import xml.etree.ElementTree as ElementTree
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MOD_CLI = REPO_ROOT / "scripts/codex_mod.mjs"
HOST_LABEL = "dev.codex-mod.host"
LAUNCH_AGENTS = Path.home() / "Library/LaunchAgents"
LOG_DIR = Path.home() / "Library/Logs/codex-mod"
NODE_CANDIDATES = (
    Path("/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"),
    Path("/Applications/Codex.app/Contents/Resources/cua_node/bin/node"),
)
LOCALE_MARKER = b'"codex.profileFooter.openProfileMenu":"'

APP = Path("/Applications/ChatGPT.app")


def node() -> Path:
    found = next((candidate for candidate in NODE_CANDIDATES if candidate.is_file()), None)
    if found is None:
        raise RuntimeError("the Node.js inside Codex was not found")
    return found


def mod_cli(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([str(node()), str(MOD_CLI), *args], capture_output=True, text=True)


def codex_pids(app: Path) -> list[int]:
    """Running Codex main processes of ``app``."""
    output = subprocess.run(["/bin/ps", "-axo", "pid=,args="], capture_output=True, text=True).stdout
    executable = str(app / "Contents/MacOS/")
    pids = []
    for line in output.splitlines():
        pid, _, arguments = line.strip().partition(" ")
        if arguments.startswith(executable) and "--type=" not in arguments:
            pids.append(int(pid))
    return pids


def launchctl(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["/bin/launchctl", *args], capture_output=True, text=True)


def launch_domain() -> str:
    return f"gui/{os.getuid()}"


def stop_agent(label: str) -> None:
    if launchctl("print", f"{launch_domain()}/{label}").returncode != 0:
        return
    launchctl("bootout", f"{launch_domain()}/{label}")
    deadline = time.monotonic() + 15
    while launchctl("print", f"{launch_domain()}/{label}").returncode == 0 and time.monotonic() < deadline:
        time.sleep(0.2)


def renderer_chunks(asar: Path) -> dict[str, bytes]:
    """The renderer chunks packed into ``asar``, read through the archive header."""
    with asar.open("rb") as handle:
        pickle_size = int.from_bytes(handle.read(8)[4:8], "little")
        pickle = handle.read(pickle_size)
        header_length = int.from_bytes(pickle[4:8], "little")
        header = json.loads(pickle[8 : 8 + header_length])
        node_entry = header
        for part in ("webview", "assets"):
            node_entry = node_entry.get("files", {}).get(part, {})
        found = []

        def walk(entry: dict, prefix: str) -> None:
            for name, child in entry.get("files", {}).items():
                if "files" in child:
                    walk(child, f"{prefix}/{name}")
                elif name.endswith(".js") and "offset" in child:
                    found.append((f"{prefix}/{name}", child))

        walk(node_entry, "assets")
        chunks = {}
        for name, child in sorted(found, key=lambda item: int(item[1]["offset"])):
            handle.seek(8 + pickle_size + int(child["offset"]))
            chunks[name] = handle.read(child["size"])
        return chunks
BUNDLE_ID = "com.openai.codex"
APPCAST_URL = "https://persistent.oaistatic.com/codex-app-prod/appcast.xml"
SPARKLE = "{http://www.andymatuschak.org/xml-namespaces/sparkle}"
STATE_DIR = Path.home() / "Library/Application Support/codex-mod-dev"
STATE_FILE = STATE_DIR / "state.json"
TASK_FILE = STATE_DIR / "agent-task.md"
BUILDS_DIR = STATE_DIR / "builds"
DOWNLOADS_DIR = STATE_DIR / "downloads"
REPORTS_DIR = STATE_DIR / "reports"
KEEP_BUILDS = 3
MOD_PORT = 48123
STOCK_PORT = 48124
CHECK_LABEL = "dev.codex-mod.update-check"
RETRIGGER_AFTER_SECONDS = 12 * 3600
# Codex's own message ids in the areas the mod extends or replaces. A release
# that adds, drops or rewords them may collide with the mod even while every
# patch still applies. The bundle also carries the whole ChatGPT web app,
# whose messages are out of scope.
MESSAGE_SCOPE_RE = re.compile(r"^(codex|electron|desktop|accountSwitch|appServer)\.", re.IGNORECASE)
DOMAIN_RE = re.compile(
    r"account|workspace|profile|usage|rate.?limit|credit|plan|provider|sign.?in|log.?in|log.?out|session|switch",
    re.IGNORECASE,
)
# Codex renders its English text from the defaultMessage next to each message
# id in the code; the quoting differs between bundler generations.
MESSAGE_RE = re.compile(r"""id:([`"'])([\w.\-]+)\1,defaultMessage:([`"'])((?:(?!\3)[^\\]|\\.)*)\3""")


def log(message: str) -> None:
    print(f"[codex-update] {message}", flush=True)


def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text())
    except (OSError, ValueError):
        return {}


def save_state(state: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    temporary = STATE_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2) + "\n")
    os.replace(temporary, STATE_FILE)


def version_key(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in re.findall(r"\d+", version))


def app_version(app: Path) -> str | None:
    try:
        with (app / "Contents/Info.plist").open("rb") as handle:
            return plistlib.load(handle).get("CFBundleShortVersionString")
    except (OSError, plistlib.InvalidFileException):
        return None


def team_identifier(app: Path) -> str | None:
    result = subprocess.run(["/usr/bin/codesign", "-dv", str(app)], capture_output=True, text=True)
    match = re.search(r"^TeamIdentifier=(\S+)", result.stderr, re.MULTILINE)
    return None if match is None else match.group(1)


def appcast_latest() -> dict:
    request = urllib.request.Request(APPCAST_URL, headers={"User-Agent": "codex-mod-update-check"})
    with urllib.request.urlopen(request, timeout=30) as response:
        root = ElementTree.fromstring(response.read())
    releases = []
    for item in root.iter("item"):
        enclosure = item.find("enclosure")
        version = item.findtext(f"{SPARKLE}shortVersionString")
        if enclosure is None or version is None:
            continue
        releases.append(
            {
                "version": version,
                "build": item.findtext(f"{SPARKLE}version"),
                "published": item.findtext("pubDate"),
                "url": enclosure.get("url"),
                "length": int(enclosure.get("length") or 0),
            }
        )
    if not releases:
        raise RuntimeError("the appcast lists no releases")
    return max(releases, key=lambda release: version_key(release["version"]))


def archived_builds() -> list[tuple[str, Path]]:
    builds = [
        (path.name, path / APP.name)
        for path in BUILDS_DIR.glob("*")
        if (path / APP.name / "Contents/Info.plist").is_file()
    ]
    return sorted(builds, key=lambda item: version_key(item[0]))


def archive_installed_build() -> None:
    """Keep a copy of the installed build so later runs can compare against it.

    The copy is an APFS clone, so it costs no space until the original changes.
    """
    version = app_version(APP)
    if version is None:
        return
    target = BUILDS_DIR / version / APP.name
    if target.exists():
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["/bin/cp", "-cR", str(APP), str(target)], check=True)
    log(f"archived Codex {version}")
    for old_version, path in archived_builds()[:-KEEP_BUILDS]:
        shutil.rmtree(path.parent, ignore_errors=True)
        log(f"removed archived Codex {old_version}")


def pending_work(state: dict, latest: dict | None) -> dict | None:
    installed = app_version(APP)
    if latest is not None and installed is not None and version_key(latest["version"]) > version_key(installed):
        return {"action": "install", "version": latest["version"], "installed": installed}
    if installed is not None and state.get("verified", {}).get("version") != installed:
        return {"action": "verify", "version": installed, "installed": installed}
    return None


def start_agent_task(work: dict) -> bool:
    try:
        task = TASK_FILE.read_text()
    except OSError:
        log(f"no agent task at {TASK_FILE}")
        return False
    t3 = shutil.which("t3") or str(Path.home() / ".local/bin/t3")
    result = subprocess.run(
        [t3, "thread", "start", "--title", f"Codex {work['version']}: update check", str(REPO_ROOT), "-"],
        input=task,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        log(f"t3 thread start failed: {(result.stderr or result.stdout).strip()[-400:]}")
    return result.returncode == 0


def command_check(trigger: bool) -> int:
    state = load_state()
    archive_installed_build()
    try:
        latest = appcast_latest()
    except (OSError, ValueError, RuntimeError) as error:
        log(f"appcast unreachable: {error}")
        latest = None
    work = pending_work(state, latest)
    state["last_check"] = {"at": time.time(), "latest": latest and latest["version"], "installed": app_version(APP)}
    triggered = state.get("triggered", {})
    if trigger and work is not None:
        recent = (
            triggered.get("version") == work["version"]
            and time.time() - triggered.get("at", 0) < RETRIGGER_AFTER_SECONDS
        )
        if recent:
            log(f"agent already started for {work['version']}")
        elif start_agent_task(work):
            state["triggered"] = {"version": work["version"], "action": work["action"], "at": time.time()}
            log(f"started the agent task: {work['action']} {work['version']}")
    save_state(state)
    print(json.dumps({"pending": work, "latest": latest and latest["version"], "installed": app_version(APP)}))
    return 0


def codex_running() -> bool:
    return bool(codex_pids(APP))


def quit_codex() -> None:
    if not codex_running():
        return
    subprocess.run(["/usr/bin/osascript", "-e", f'tell application id "{BUNDLE_ID}" to quit'], capture_output=True)
    deadline = time.monotonic() + 30
    while codex_running() and time.monotonic() < deadline:
        time.sleep(0.5)
    # A native alert such as "Restart to apply workspace settings" blocks a
    # polite quit; the run must not hang on it.
    for signal_number, wait in ((15, 15), (9, 5)):
        for pid in codex_pids(APP):
            try:
                os.kill(pid, signal_number)
            except ProcessLookupError:
                continue
        deadline = time.monotonic() + wait
        while codex_running() and time.monotonic() < deadline:
            time.sleep(0.5)
    if codex_running():
        raise RuntimeError("Codex did not quit")


def download(url: str, target: Path, length: int) -> None:
    if target.is_file() and target.stat().st_size == length:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(".part")
    log(f"downloading {url}")
    request = urllib.request.Request(url, headers={"User-Agent": "codex-mod-update-check"})
    with urllib.request.urlopen(request, timeout=60) as response, partial.open("wb") as handle:
        shutil.copyfileobj(response, handle, length=1 << 20)
    if length and partial.stat().st_size != length:
        raise RuntimeError(f"download is {partial.stat().st_size} bytes, the appcast says {length}")
    os.replace(partial, target)


def command_install() -> int:
    latest = appcast_latest()
    installed = app_version(APP)
    if installed is not None and version_key(latest["version"]) <= version_key(installed):
        log(f"Codex {installed} is the newest release")
        return 0
    archive_installed_build()
    archive = DOWNLOADS_DIR / f"{latest['version']}.zip"
    download(latest["url"], archive, latest["length"])
    staging = DOWNLOADS_DIR / f"{latest['version']}-staging"
    shutil.rmtree(staging, ignore_errors=True)
    subprocess.run(["/usr/bin/ditto", "-x", "-k", str(archive), str(staging)], check=True)
    staged = next(staging.glob("*.app"))
    if app_version(staged) != latest["version"]:
        raise RuntimeError(f"the download contains {app_version(staged)}, not {latest['version']}")
    subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(staged)], check=True)
    expected_team = team_identifier(APP)
    if expected_team is not None and team_identifier(staged) != expected_team:
        raise RuntimeError("the download is not signed by the same team as the installed Codex")
    quit_codex()
    retired = STATE_DIR / f"retired-{int(time.time())}.app"
    os.rename(APP, retired)
    try:
        os.rename(staged, APP)
    except OSError:
        os.rename(retired, APP)
        raise
    shutil.rmtree(retired, ignore_errors=True)
    shutil.rmtree(staging, ignore_errors=True)
    archive.unlink(missing_ok=True)
    archive_installed_build()
    log(f"installed Codex {latest['version']} (was {installed})")
    subprocess.run(["/usr/bin/open", str(APP)], check=True)
    return 0


def dry_run(app: Path = APP) -> dict:
    result = mod_cli("dry-run", "--asar", str(app / "Contents/Resources/app.asar"))
    lines = [line.removeprefix("[codex-desktop-patch] ") for line in (result.stdout + result.stderr).splitlines()]
    return {
        "ok": result.returncode == 0,
        "degraded": [line for line in lines if "not found" in line or "no locale chunks" in line],
        "error": None if result.returncode == 0 else next((line for line in reversed(lines) if line.strip()), ""),
        "patched": next((line for line in lines if line.startswith("renderer cache:")), None),
    }


def english_messages(app: Path) -> dict[str, str]:
    messages = {}
    for data in renderer_chunks(app / "Contents/Resources/app.asar").values():
        if LOCALE_MARKER in data or b"defaultMessage" not in data:
            continue
        for _, key, _, value in MESSAGE_RE.findall(data.decode("utf-8", "ignore")):
            messages.setdefault(key, value.replace("\\n", " "))
    return messages


def build_diff(previous: Path | None) -> dict | None:
    """Messages in the mod's areas that the installed build added, dropped or reworded."""
    if previous is None:
        return None
    before, after = english_messages(previous), english_messages(APP)
    if not before or not after:
        return {"error": "no English message catalog found"}

    def relevant(key: str, text: str) -> bool:
        return bool(MESSAGE_SCOPE_RE.search(key) and DOMAIN_RE.search(key))

    added = {k: v for k, v in after.items() if k not in before and relevant(k, v)}
    removed = {k: v for k, v in before.items() if k not in after and relevant(k, v)}
    reworded = {
        k: {"before": before[k], "after": v}
        for k, v in after.items()
        if k in before and before[k] != v and relevant(k, v)
    }
    return {
        "previous": app_version(previous),
        "messages": {"before": len(before), "after": len(after)},
        "added": dict(list(added.items())[:60]),
        "removed": dict(list(removed.items())[:60]),
        "reworded": dict(list(reworded.items())[:60]),
        "counts": {"added": len(added), "removed": len(removed), "reworded": len(reworded)},
    }


def wait_for_port(port: int, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2):
                return True
        except OSError:
            time.sleep(1)
    return False


def run_verify(mode: str, port: int, out: Path) -> dict:
    result = subprocess.run(
        [str(node()), str(REPO_ROOT / "dev/verify.mjs"), "--mode", mode, "--port", str(port), "--out", str(out)],
        capture_output=True,
        text=True,
        timeout=600,
    )
    report = out / f"{mode}.json"
    if report.is_file():
        return json.loads(report.read_text())
    return {"mode": mode, "checks": [{"id": "run.completed", "ok": False, "severity": "required",
                                      "detail": {"error": (result.stderr or result.stdout)[-800:]}}]}


def codex_home_environment() -> list[str]:
    home = mod_cli("codex-home").stdout.strip() or None
    return [] if home is None else ["--env", f"CODEX_HOME={home}"]


def host_off() -> None:
    """Disable and stop the host without relaunching Codex, unlike ``make off``."""
    launchctl("disable", f"{launch_domain()}/{HOST_LABEL}")
    stop_agent(HOST_LABEL)


def start_codex_with_mod() -> None:
    """A fresh Codex under the host, so no alert left from earlier use blocks the run."""
    quit_codex()
    enabled = mod_cli("on")
    if enabled.returncode != 0:
        raise RuntimeError((enabled.stderr or enabled.stdout).strip())
    subprocess.run(["/usr/bin/open", str(APP)], check=True)
    wait_for_port(MOD_PORT, 120)


def run_failed_to_start(run: dict) -> bool:
    return any(c["id"] in {"app.ready", "run.completed"} and not c["ok"] for c in run.get("checks", []))


def live_runs(out: Path) -> dict:
    """The scenarios once with the mod and once stock, leaving Codex with the mod.

    A run whose app never became ready is repeated once after a fresh launch:
    a native alert, for example, freezes Codex's DevTools endpoint.
    """
    runs = {}
    start_codex_with_mod()
    runs["mod"] = run_verify("mod", MOD_PORT, out)
    if run_failed_to_start(runs["mod"]):
        log("mod run did not start; retrying after a fresh launch")
        start_codex_with_mod()
        runs["mod"] = run_verify("mod", MOD_PORT, out)

    host_off()
    try:
        for attempt in range(2):
            quit_codex()
            subprocess.run(
                ["/usr/bin/open", *codex_home_environment(), str(APP), "--args", f"--remote-debugging-port={STOCK_PORT}"],
                check=True,
            )
            runs["stock"] = run_verify("stock", STOCK_PORT, out) if wait_for_port(STOCK_PORT, 90) else {
                "mode": "stock", "checks": [{"id": "app.ready", "ok": False, "severity": "required", "detail": {}}]}
            if not run_failed_to_start(runs["stock"]):
                break
            log("stock run did not start; retrying after a fresh launch")
    finally:
        start_codex_with_mod()
    return runs


def native_behaviour(run: dict | None) -> dict | None:
    header = ((run or {}).get("scenarios") or {}).get("profileMenu", {}).get("header")
    return None if header is None else {"nativeSubmenu": header.get("nativeSubmenu"), "disabled": header.get("disabled")}


def scrub(value):
    """Drop local paths, the user and the host name from anything quoted in a report."""
    replacements = [
        (re.compile(r"/(?:private/)?var/folders/\S+"), "<temp>"),
        (re.compile(re.escape(str(Path.home()))), "~"),
        (re.compile(rf"\b{re.escape(os.environ.get('USER', '') or '-')}\b"), "<user>"),
        (re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+"), "<email>"),
    ]
    if isinstance(value, dict):
        return {key: scrub(item) for key, item in value.items()}
    if isinstance(value, list):
        return [scrub(item) for item in value]
    if isinstance(value, str):
        for pattern, replacement in replacements:
            value = pattern.sub(replacement, value)
    return value


def verdict_for(report: dict) -> tuple[str, list[str]]:
    reasons = []
    level = "green"

    def raise_to(new: str, reason: str) -> None:
        nonlocal level
        order = ["green", "yellow", "red"]
        if order.index(new) > order.index(level):
            level = new
        reasons.append(f"{new}: {reason}")

    if not report["patcher"]["ok"]:
        raise_to("red", f"the patcher refuses this build ({report['patcher']['error']})")
    for line in report["patcher"]["degraded"]:
        raise_to("yellow", f"patcher: {line}")
    for version, result in report.get("archived_patchers", {}).items():
        if not result["ok"]:
            raise_to("red", f"the patcher refuses retained build {version} ({result['error']})")
    for check in report["runs"].get("mod", {}).get("checks", []):
        if not check["ok"]:
            raise_to("red" if check["severity"] == "required" else "yellow", f"with mod: {check['id']} failed")
    for check in report["runs"].get("stock", {}).get("checks", []):
        if not check["ok"] and check["severity"] == "required":
            raise_to("yellow", f"stock: {check['id']} failed")
    diff = report.get("build_diff") or {}
    if any((diff.get("counts") or {}).values()):
        raise_to("yellow", f"Codex changed messages in the mod's areas: {diff['counts']}")
    if report.get("native_changed"):
        raise_to("yellow", f"Codex's own profile menu behaves differently: {report['native_changed']}")
    return level, reasons


def summary_markdown(report: dict) -> str:
    lines = [
        f"# Codex {report['codex']}: {report['verdict'].upper()}",
        "",
        f"- Mod release: {report['mod_release']}",
        f"- Compared with: {report['previous'] or 'nothing (first run)'}",
        f"- Patcher: {'ok' if report['patcher']['ok'] else 'FAILED'}; {report['patcher']['patched'] or ''}",
        "",
        "## Reasons" if report["reasons"] else "## Reasons\n\nNone; every check passed.",
    ]
    lines += [f"- {reason}" for reason in report["reasons"]]
    for mode, run in report["runs"].items():
        failed = [c for c in run.get("checks", []) if not c["ok"]]
        lines += ["", f"## {mode} run: {len(run.get('checks', [])) - len(failed)}/{len(run.get('checks', []))} checks pass"]
        lines += [f"- {c['severity']} {c['id']}: {json.dumps(c.get('detail', {}))}" for c in failed]
    diff = report.get("build_diff")
    if diff and any((diff.get("counts") or {}).values()):
        lines += ["", "## Changed messages in the mod's areas"]
        for kind in ("added", "removed", "reworded"):
            for key, value in diff.get(kind, {}).items():
                lines.append(f"- {kind} `{key}`: {json.dumps(value)}")
    lines += ["", "## Media", ""] + [f"- {name}" for name in report["media"]]
    return "\n".join(lines) + "\n"


def command_verify() -> int:
    version = app_version(APP)
    if version is None:
        raise RuntimeError(f"{APP} is not installed")
    archive_installed_build()
    out = REPORTS_DIR / version
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    previous_builds = [path for v, path in archived_builds() if version_key(v) < version_key(version)]
    previous = previous_builds[-1] if previous_builds else None
    previous_reports = sorted(
        (p for p in REPORTS_DIR.glob("*") if p.is_dir() and p.name != version and version_key(p.name) < version_key(version)),
        key=lambda p: version_key(p.name),
    )
    previous_report = previous_reports[-1] if previous_reports else None

    log("patcher dry run")
    patcher = dry_run()
    archived_patchers = {}
    for archived_version, app in archived_builds():
        if archived_version != version:
            log(f"patcher dry run against retained build {archived_version}")
            archived_patchers[archived_version] = dry_run(app)
    log("comparing message catalogs")
    diff = build_diff(previous)
    log("live runs")
    runs = live_runs(out)
    native_changed = None
    if previous_report is not None:
        try:
            before = native_behaviour(json.loads((previous_report / "stock.json").read_text()))
        except (OSError, ValueError):
            before = None
        after = native_behaviour(runs.get("stock"))
        if before is not None and after is not None and before != after:
            native_changed = {"before": before, "after": after}
    report = {
        "codex": version,
        "previous": previous and app_version(previous),
        "mod_release": subprocess.run(
            ["git", "-C", str(REPO_ROOT), "describe", "--tags", "--always", "--dirty"],
            capture_output=True,
            text=True,
        ).stdout.strip() or None,
        "patcher": patcher,
        "archived_patchers": archived_patchers,
        "build_diff": diff,
        "native_changed": native_changed,
        "runs": runs,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    report = scrub(report)
    report["verdict"], report["reasons"] = verdict_for(report)
    # Every screenshot and recording stays its own file at full resolution;
    # the reader picks what to show rather than getting a merged collage.
    report["media"] = sorted(p.name for p in out.iterdir() if p.suffix in {".png", ".mp4"})
    report["previous_report"] = previous_report and scrub(str(previous_report))
    (out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    (out / "summary.md").write_text(summary_markdown(report))
    state = load_state()
    state["verified"] = {"version": version, "verdict": report["verdict"], "at": time.time(), "report": str(out)}
    save_state(state)
    print(json.dumps({"verdict": report["verdict"], "reasons": report["reasons"], "report": str(out)}, indent=2))
    return 0


def command_install_agent() -> None:
    configuration = {
        "Label": CHECK_LABEL,
        "ProgramArguments": [sys.executable, str(Path(__file__).resolve()), "check", "--trigger"],
        "StartInterval": 3600,
        "RunAtLoad": True,
        "WorkingDirectory": str(REPO_ROOT),
        "StandardOutPath": str(LOG_DIR / "update-check.log"),
        "StandardErrorPath": str(LOG_DIR / "update-check.log"),
    }
    plist = LAUNCH_AGENTS / f"{CHECK_LABEL}.plist"
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=plist.parent, delete=False) as handle:
        plistlib.dump(configuration, handle, sort_keys=False)
    os.replace(handle.name, plist)
    plist.chmod(0o644)
    stop_agent(CHECK_LABEL)
    result = launchctl("bootstrap", launch_domain(), str(plist))
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    log(f"installed {plist}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check")
    check.add_argument("--trigger", action="store_true")
    sub.add_parser("install")
    sub.add_parser("verify")
    sub.add_parser("status")
    sub.add_parser("install-agent")
    args = parser.parse_args()
    try:
        if args.command == "check":
            return command_check(args.trigger)
        if args.command == "install":
            return command_install()
        if args.command == "verify":
            return command_verify()
        if args.command == "status":
            print(json.dumps(load_state(), indent=2))
        elif args.command == "install-agent":
            command_install_agent()
        return 0
    except (OSError, RuntimeError, subprocess.SubprocessError, ValueError) as error:
        log(f"failed: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
