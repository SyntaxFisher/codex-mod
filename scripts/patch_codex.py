#!/usr/bin/env python3
"""Patch Codex Desktop with a provider profile switcher and provider-wide history."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

import manage_launch_agent


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
CODEX_HOME = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
PROFILE_SWITCHER_SOURCE = SCRIPT_DIR / "profile_switcher.cjs"
ASAR_CLI = REPO_ROOT / "node_modules/@electron/asar/bin/asar.mjs"
ASAR_PACKER = SCRIPT_DIR / "pack_preserving_unpacked.mjs"
BACKUP_DIR = CODEX_HOME / "backups/codex-app-asar"
STATE_PATH = CODEX_HOME / ".codex-mod-state.json"
# The app cannot pass arguments through launchctl kickstart, so it leaves
# request markers that the next patcher run consumes.
CHECK_REQUEST_PATH = CODEX_HOME / ".codex-mod-check-request"
UPDATE_REQUEST_PATH = CODEX_HOME / ".codex-mod-update-request"
UNINSTALL_REQUEST_PATH = CODEX_HOME / ".codex-mod-uninstall-request"
UNINSTALLED_SENTINEL_PATH = CODEX_HOME / ".codex-mod-uninstalled"
# Handshake for the App Management probe: an interactive patch asks the launch
# agent to test bundle write access from the launchd context, because the
# terminal's own permission says nothing about the agent's.
PROBE_REQUEST_PATH = CODEX_HOME / ".codex-mod-probe-request"
PROBE_RESULT_PATH = CODEX_HOME / ".codex-mod-probe.json"
PROGRESS_PATH = CODEX_HOME / ".codex-mod-progress.json"
# Written by the app's Automatic Updates toggle and read on every run, so
# switching modes never has to reload the launch agent.
CONFIG_PATH = CODEX_HOME / ".codex-mod-config.json"


def content_marker(name: str, content: str) -> str:
    fingerprint = hashlib.sha256(content.encode()).hexdigest()[:12]
    return f"{name}:{fingerprint}"


PROFILE_SWITCHER_MARKER = content_marker(
    "codex-profile-switcher", PROFILE_SWITCHER_SOURCE.read_text(encoding="utf-8")
)
PROFILE_RESTART_BRIDGE_MARKER = content_marker(
    "codex-profile-restart-bridge",
    "dispatch codex-app-server-restart for the local host and return true",
)

DEFAULT_ASAR_CANDIDATES = (
    Path("/Applications/ChatGPT.app/Contents/Resources/app.asar"),
    Path("/Applications/Codex.app/Contents/Resources/app.asar"),
)

IDENT = r"[A-Za-z_$][A-Za-z0-9_$]*"
RECENT_PROVIDER_FILTER_RE = re.compile(
    rf"(listRecentThreads\([^)]*\)\{{[^;]{{0,1200}}?modelProviders:)"
    rf"{IDENT}(?=,archived:!1)"
)
RECENT_PROVIDER_WIDE_RE = re.compile(
    r"listRecentThreads\([^)]*\)\{[^;]{0,1200}?modelProviders:\[\](?=,archived:!1)"
)
ARCHIVED_PROVIDER_FILTER_RE = re.compile(
    rf"(listArchivedThreads\(\)\{{return this\.listAllThreads\(\{{modelProviders:)"
    rf"{IDENT}(?=,archived:!0\}}\)\}})"
)
ARCHIVED_PROVIDER_WIDE_RE = re.compile(
    r"listArchivedThreads\(\)\{return this\.listAllThreads\(\{modelProviders:\[\],"
    r"archived:!0\}\)\}"
)
ALL_PROVIDER_NULL_RE = re.compile(r"modelProviders:null")
PROFILE_SWITCHER_INJECTION_RE = re.compile(
    r'\n;try\{require\("\./codex-profile-switcher\.cjs"\)\.install\(\)\}'
    r"catch\([^)]*\)\{[^\n]*\}/\* codex-profile-switcher:(?:v\d+|[0-9a-f]+) \*/\n?"
)
PROFILE_RESTART_DISPATCH_RE = re.compile(
    rf"function {IDENT}\(({IDENT})\)\{{({IDENT})\.dispatchMessage\("
    r"`codex-app-server-restart`,\{hostId:\1,intent:`restart`,errorMessage:null\}\)\}"
)
PROFILE_RESTART_BRIDGE_INJECTION_RE = re.compile(
    r";globalThis\.__codexProfileRestart=.*?"
    r"/\* codex-profile-restart-bridge:(?:v\d+|[0-9a-f]+) \*/"
)
PROFILE_SWITCH_DISPATCH_INJECTION_RE = re.compile(
    r"/\* codex-profile-switch-dispatch:v\d+ \*/"
    r"case`codex-profile-switch`:await globalThis\.__codexProfileSwitch\?\.\("
    rf"{IDENT}\.provider\);break;"
)
ACTIVE_PROVIDER_RESUME_SOURCE = (
    "??(()=>{try{let p=localStorage.getItem(`__codex_active_provider`);"
    "return typeof p==`string`&&p.length>0?p:null}catch{return null}})()"
)
ACTIVE_PROVIDER_RESUME_MARKER = content_marker(
    "codex-active-provider-resume", ACTIVE_PROVIDER_RESUME_SOURCE
)
RESUME_PROVIDER_SITE_RE = re.compile(
    rf"(sendRequest\(`thread/resume`,\{{[^;]{{0,400}}?modelProvider:)"
    rf"({IDENT})\.modelProvider(?=,)"
)
USAGE_RESETS_BRIDGE_SOURCE = "globalThis.__codexOpenUsageResets=<handler>"
USAGE_RESETS_BRIDGE_MARKER = content_marker(
    "codex-usage-resets-bridge", USAGE_RESETS_BRIDGE_SOURCE
)
# The prop site appears twice, once as a destructuring pattern that cannot hold
# an assignment, so the handler's own definition is the anchor instead.
USAGE_RESETS_SITE_RE = re.compile(
    rf"({IDENT})=\(\)=>\{{(?=[^{{}}]*\{{defaultResetCreditsOpen:!0)"
)
USAGE_RESETS_OVERRIDE_RE = re.compile(
    r"/\* codex-usage-resets-bridge:[0-9a-f]+:start \*/"
    r"\(globalThis\.__codexOpenUsageResets=(.*?)\)"
    r"/\* codex-usage-resets-bridge:[0-9a-f]+:end \*/",
    re.DOTALL,
)
RESUME_PROVIDER_OVERRIDE_RE = re.compile(
    rf"/\* codex-active-provider-resume:[0-9a-f]+:start \*/"
    rf"\(({IDENT})\.modelProvider.*?"
    rf"/\* codex-active-provider-resume:[0-9a-f]+:end \*/",
    re.DOTALL,
)


VERSION_TAG_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")


def parse_version(tag: str) -> tuple[int, int, int] | None:
    match = VERSION_TAG_RE.match(tag.strip())
    if match is None:
        return None
    major, minor, patch = match.groups()
    return (int(major), int(minor), int(patch))


def run_git(*args: str, timeout: float | None = None) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(REPO_ROOT), *args],
            text=True,
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return None
    return result.stdout if result.returncode == 0 else None


def repository_head() -> str | None:
    output = run_git("rev-parse", "HEAD")
    return output.strip() if output else None


def repository_describe() -> str | None:
    output = run_git("describe", "--tags", "--always", "--dirty")
    return output.strip() if output else None


def commit_subject() -> str | None:
    output = run_git("log", "-1", "--format=%s")
    return output.strip() if output else None


def local_release() -> str | None:
    """The newest release tag reachable from HEAD."""
    output = run_git("tag", "--merged", "HEAD")
    if output is None:
        return None
    releases = [tag for tag in output.split() if parse_version(tag) is not None]
    return max(releases, key=parse_version) if releases else None


def upstream_remote() -> str:
    output = run_git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    if output is None:
        return "origin"
    remote, _, branch = output.strip().partition("/")
    return remote if remote and branch else "origin"


def remote_release() -> tuple[str | None, bool]:
    """The newest remote release tag, and whether the remote answered at all."""
    output = run_git("ls-remote", "--tags", upstream_remote(), timeout=30)
    if output is None:
        return None, False
    releases = []
    for line in output.splitlines():
        fields = line.split("\t")
        if len(fields) != 2:
            continue
        tag = fields[1].removeprefix("refs/tags/").removesuffix("^{}")
        if parse_version(tag) is not None:
            releases.append(tag)
    return (max(releases, key=parse_version) if releases else None), True


def newer_release(candidate: str | None, baseline: object) -> bool:
    if candidate is None:
        return False
    parsed = parse_version(candidate)
    if parsed is None:
        return False
    baseline_parsed = (
        parse_version(baseline) if isinstance(baseline, str) else None
    )
    return baseline_parsed is None or parsed > baseline_parsed


def newest_local_release() -> str | None:
    output = run_git("tag", "--list")
    if output is None:
        return None
    releases = [tag for tag in output.split() if parse_version(tag) is not None]
    return max(releases, key=parse_version) if releases else None


def tag_commit(tag: str) -> str | None:
    output = run_git("rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}")
    return output.strip() if output is not None else None


def resolve_target_release(requested: str) -> str | None:
    """The release tag to install, or None to patch the current checkout."""
    if requested == "head":
        return None
    if requested == "latest":
        remote, _ = remote_release()
        if remote is not None:
            return remote
        fallback = newest_local_release()
        if fallback is not None:
            print(
                "[codex-desktop-patch] remote unreachable; "
                f"using local release {fallback}"
            )
            return fallback
        print(
            "[codex-desktop-patch] no release tags found; "
            "patching the current checkout"
        )
        return None
    if parse_version(requested) is None:
        raise RuntimeError(f"not a release tag: {requested}")
    return requested


def switch_to_release(tag: str) -> None:
    if tag_commit(tag) is None:
        print(f"[codex-desktop-patch] fetching tags to find {tag}")
        run_git("fetch", "--tags", upstream_remote(), timeout=60)
    if tag_commit(tag) is None:
        raise RuntimeError(f"release tag {tag} was not found")
    if run_git("checkout", "--detach", tag) is None:
        raise RuntimeError(
            f"could not check out {tag}; commit or stash local changes first"
        )


def pull_patch_sources() -> tuple[bool, str | None]:
    """Fast-forward the repository; report whether HEAD moved and any error."""
    head_before = repository_head()
    if head_before is None:
        return False, "the repository state could not be read"
    try:
        result = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "pull", "--ff-only", "--quiet"],
            text=True,
            capture_output=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        return False, "git pull timed out"
    if result.returncode != 0:
        return False, result.stderr.strip() or result.stdout.strip() or "git pull failed"
    return repository_head() != head_before, None


def write_progress(percent: int, label: str) -> None:
    """Report patch progress for the app's progress window; best effort."""
    try:
        PROGRESS_PATH.write_text(
            json.dumps({"percent": percent, "label": label, "at": time.time()}),
            encoding="utf-8",
        )
    except OSError:
        pass


def automatic_updates_enabled() -> bool:
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return True
    return not isinstance(config, dict) or config.get("automaticUpdates") is not False


def refresh_launch_agent(asar: Path) -> None:
    """Install the launch agent, or reinstall it when its plist is out of date."""
    installed = manage_launch_agent.installed_configuration()
    if installed == manage_launch_agent.agent_configuration(asar):
        return
    print("[codex-desktop-patch] installing the launch agent")
    # Detached, because reinstalling boots out the agent job this patcher may be
    # running under; the reinstall must survive that kill.
    subprocess.Popen(
        [
            sys.executable,
            str(manage_launch_agent.__file__),
            "install",
            "--asar",
            str(asar),
        ],
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def default_asar() -> Path:
    return next(
        (path for path in DEFAULT_ASAR_CANDIDATES if path.exists()),
        DEFAULT_ASAR_CANDIDATES[0],
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_state() -> dict[str, object]:
    try:
        with STATE_PATH.open(encoding="utf-8") as handle:
            state = json.load(handle)
    except (OSError, ValueError):
        return {}
    return state if isinstance(state, dict) else {}


def write_state(state: dict[str, object]) -> None:
    try:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            "w", dir=STATE_PATH.parent, delete=False, encoding="utf-8"
        ) as handle:
            temporary_path = Path(handle.name)
            json.dump(state, handle, indent=2)
        os.replace(temporary_path, STATE_PATH)
    except OSError as error:
        print(f"[codex-desktop-patch] could not record state: {error}")


def record_state(
    asar: Path,
    remote: str | None,
    reachable: bool,
    result: str,
    error: str | None = None,
    extra: dict[str, object] | None = None,
) -> None:
    """Remember what the last run left behind, and how it went."""
    previous = read_state()
    status = asar.stat()
    state: dict[str, object] = {
        "asar_sha256": sha256(asar),
        "asar_size": status.st_size,
        "asar_mtime_ns": status.st_mtime_ns,
        "head": repository_head(),
        # A failed run has pulled sources it never installed, so the release
        # baseline must stay at the version that actually landed; otherwise
        # update checks read the stranded checkout as up to date.
        "release": previous.get("release") if result == "failed" else local_release(),
        "describe": repository_describe(),
        # Keep the last reachable value so an offline run does not force a
        # full patch on the next tick.
        "remote_release": (
            remote if reachable else previous.get("remote_release")
        ),
        "remote_reachable": reachable,
        "original_backup": previous.get("original_backup"),
        "result": result,
        "error": error,
        "checked_at": time.time(),
    }
    if extra:
        state.update(extra)
    write_state(state)


def stamp_state(
    result: str, remote: str | None, reachable: bool, error: str | None = None
) -> None:
    """Stamp a check outcome without rehashing the ASAR."""
    state = read_state()
    if reachable:
        state["remote_release"] = remote
    state["remote_reachable"] = reachable
    state["result"] = result
    state["error"] = error
    state["checked_at"] = time.time()
    write_state(state)


def asar_unchanged(asar: Path, state: dict[str, object]) -> bool:
    status = asar.stat()
    if (
        state.get("asar_size") == status.st_size
        and state.get("asar_mtime_ns") == status.st_mtime_ns
    ):
        return True
    return state.get("asar_sha256") == sha256(asar)


def patch_work_pending(asar: Path, remote: str | None) -> bool:
    """Whether anything the last run depended on has moved since."""
    state = read_state()
    if not state:
        return True
    if not asar_unchanged(asar, state):
        return True
    # Local commits alone never trigger the agent; releases are cut with tags
    # and development builds are installed explicitly with make patch. An
    # unreachable remote is not a change either, which keeps offline ticks
    # from repacking the ASAR every time.
    if newer_release(remote, state.get("release")):
        return True
    # A failed run left the install behind its sources, so keep retrying on
    # every tick until a run completes.
    return state.get("result") == "failed"


def find_node(asar: Path) -> Path:
    candidates = (
        asar.parent / "cua_node/bin/node",
        Path("/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"),
        Path("/Applications/Codex.app/Contents/Resources/cua_node/bin/node"),
    )
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    executable = shutil.which("node")
    if executable:
        return Path(executable)
    raise RuntimeError("Node.js was not found")


def run_asar(node: Path, *args: str | Path, cwd: Path | None = None) -> str:
    if not ASAR_CLI.is_file():
        raise RuntimeError(
            f"missing ASAR dependency: {ASAR_CLI}\nRun make setup in {REPO_ROOT} first."
        )
    result = subprocess.run(
        [str(node), str(ASAR_CLI), *(str(arg) for arg in args)],
        text=True,
        capture_output=True,
        cwd=str(cwd) if cwd is not None else None,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(f"ASAR command failed: {detail}")
    return result.stdout


def asar_package_version(node: Path, archive: Path, work_dir: Path) -> str | None:
    target = work_dir / "package.json"
    try:
        run_asar(node, "extract-file", archive, "package.json", cwd=work_dir)
        version = json.loads(target.read_text(encoding="utf-8")).get("version")
        return version if isinstance(version, str) else None
    except (RuntimeError, OSError, ValueError):
        return None
    finally:
        if target.exists():
            target.unlink()


def asar_is_patched(node: Path, archive: Path) -> bool:
    return "codex-profile-switcher.cjs" in run_asar(node, "list", archive)


def find_original_backup(node: Path, asar: Path, work_dir: Path) -> Path | None:
    """The pristine backup of the installed Codex build, if one is known."""
    recorded = read_state().get("original_backup")
    if isinstance(recorded, str) and Path(recorded).is_file():
        return Path(recorded)

    # Older installs never recorded the pristine backup, so fall back to
    # scanning for an unpatched backup of the same Codex build.
    if not BACKUP_DIR.is_dir():
        return None
    current_version = asar_package_version(node, asar, work_dir)
    if current_version is None:
        return None
    backups = sorted(
        BACKUP_DIR.glob("app.asar.*.bak"),
        key=lambda backup: backup.stat().st_mtime,
        reverse=True,
    )
    for backup in backups:
        try:
            if asar_is_patched(node, backup):
                continue
            if asar_package_version(node, backup, work_dir) == current_version:
                return backup
        except RuntimeError:
            continue
    return None


def restore_asar(asar: Path, backup: Path) -> None:
    temporary_target = (
        asar.parent / f".{asar.name}.codex-desktop-restore-{os.getpid()}.tmp"
    )
    try:
        shutil.copy2(backup, temporary_target)
        os.replace(temporary_target, asar)
    finally:
        if temporary_target.exists():
            temporary_target.unlink()


def uninstall_mod(asar: Path) -> int:
    """Restore the original ASAR and remove the launch agent."""
    try:
        UNINSTALL_REQUEST_PATH.unlink()
    except OSError:
        pass

    if not bundle_writable(asar):
        print(
            f"[codex-desktop-patch] cannot write to {asar.parent}\n"
            f"[codex-desktop-patch] {permission_hint()}",
            file=sys.stderr,
        )
        record_state(asar, None, False, "failed", error=permission_hint())
        return 1

    restored = False
    try:
        node = find_node(asar)
        with tempfile.TemporaryDirectory(
            prefix="codex-desktop-uninstall-"
        ) as temp_dir_name:
            backup = find_original_backup(node, asar, Path(temp_dir_name))
            if backup is not None:
                restore_asar(asar, backup)
                restored = True
                print(f"[codex-desktop-patch] restored original ASAR from {backup}")
            else:
                print(
                    "[codex-desktop-patch] no pristine backup found; "
                    "leaving the patched ASAR in place"
                )
    except (OSError, RuntimeError) as exc:
        print(f"[codex-desktop-patch] uninstall failed: {exc}", file=sys.stderr)
        record_state(asar, None, False, "failed", error=str(exc))
        return 1

    for leftover in (CONFIG_PATH, PROGRESS_PATH):
        try:
            leftover.unlink()
        except OSError:
            pass
    # The sentinel makes racing --if-changed runs exit before the detached
    # uninstall below has removed the agent; make patch clears it again.
    UNINSTALLED_SENTINEL_PATH.touch()
    record_state(
        asar,
        None,
        False,
        "uninstalled",
        extra={"restored": restored, "original_backup": None},
    )
    subprocess.Popen(
        [sys.executable, str(manage_launch_agent.__file__), "uninstall"],
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    print(
        "[codex-desktop-patch] removing the launch agent; "
        "restart Codex Desktop to finish"
    )
    return 0


def pack_asar(
    node: Path, source_asar: Path, extracted_dir: Path, destination_asar: Path
) -> None:
    if not ASAR_PACKER.is_file():
        raise RuntimeError(f"missing ASAR packer: {ASAR_PACKER}")
    result = subprocess.run(
        [
            str(node),
            str(ASAR_PACKER),
            str(source_asar),
            str(extracted_dir),
            str(destination_asar),
        ],
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(f"ASAR packing failed: {detail}")


def check_javascript(node: Path, bundle: Path) -> None:
    result = subprocess.run(
        [str(node), "--check", str(bundle)],
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(
            f"JavaScript syntax check failed for {bundle.name}: {detail}"
        )


def renderer_bundles(extracted_dir: Path) -> list[Path]:
    bundles = sorted((extracted_dir / "webview/assets").glob("*.js"))
    if not bundles:
        raise RuntimeError("no Codex renderer bundles were found")
    return bundles


def javascript_bundles(extracted_dir: Path) -> list[Path]:
    bundles = renderer_bundles(extracted_dir)
    bundles.extend(sorted((extracted_dir / ".vite/build").glob("*.js")))
    return bundles


def patch_provider_history(bundles: list[Path]) -> tuple[int, bool]:
    replacements = 0
    recent_provider_wide = False
    archived_provider_wide = False

    for bundle in bundles:
        text = bundle.read_text(encoding="utf-8")
        if "modelProviders:" in text:
            patched_text, all_provider_replacements = ALL_PROVIDER_NULL_RE.subn(
                "modelProviders:[]", text
            )
            patched_text, recent_replacements = RECENT_PROVIDER_FILTER_RE.subn(
                r"\1[]", patched_text
            )
            patched_text, archived_replacements = ARCHIVED_PROVIDER_FILTER_RE.subn(
                r"\1[]", patched_text
            )
            bundle_replacements = (
                all_provider_replacements + recent_replacements + archived_replacements
            )
            replacements += bundle_replacements
            if bundle_replacements:
                bundle.write_text(patched_text, encoding="utf-8")
                text = patched_text
            recent_provider_wide = (
                recent_provider_wide or RECENT_PROVIDER_WIDE_RE.search(text) is not None
            )
            archived_provider_wide = (
                archived_provider_wide
                or ARCHIVED_PROVIDER_WIDE_RE.search(text) is not None
            )

    return replacements, recent_provider_wide and archived_provider_wide


def inject_profile_restart_bridge(bundles: list[Path]) -> tuple[bool, bool]:
    preferred = sorted(
        bundles,
        key=lambda path: (
            not path.name.startswith("app-initial-"),
            path.name,
        ),
    )
    for bundle in preferred:
        text = bundle.read_text(encoding="utf-8")
        if PROFILE_RESTART_BRIDGE_MARKER in text:
            return False, True
        match = PROFILE_RESTART_DISPATCH_RE.search(text)
        if match is None:
            continue

        bridge = match.group(2)
        text = PROFILE_RESTART_BRIDGE_INJECTION_RE.sub("", text)
        injection = (
            ";globalThis.__codexProfileRestart=()=>{"
            f"{bridge}.dispatchMessage(`codex-app-server-restart`,"
            "{hostId:`local`,intent:`restart`});return!0};"
            f"/* {PROFILE_RESTART_BRIDGE_MARKER} */"
        )
        bundle.write_text(
            text[: match.end()] + injection + text[match.end() :],
            encoding="utf-8",
        )
        return True, True
    return False, False


def profile_restart_bridge_bundle(bundles: list[Path]) -> Path | None:
    for bundle in bundles:
        text = bundle.read_text(encoding="utf-8")
        if PROFILE_RESTART_BRIDGE_MARKER not in text:
            continue
        terminated_bridge = f"return!0}};/* {PROFILE_RESTART_BRIDGE_MARKER} */"
        if terminated_bridge not in text:
            raise RuntimeError("profile restart bridge is not explicitly terminated")
        return bundle
    return None


def remove_profile_switch_dispatch(bundles: list[Path]) -> int:
    removals = 0
    for bundle in bundles:
        text = bundle.read_text(encoding="utf-8")
        if "codex-profile-switch-dispatch:" not in text:
            continue
        patched_text, bundle_removals = PROFILE_SWITCH_DISPATCH_INJECTION_RE.subn(
            "", text
        )
        if bundle_removals:
            bundle.write_text(patched_text, encoding="utf-8")
            removals += bundle_removals
    return removals


def inject_active_provider_resume(bundles: list[Path]) -> tuple[bool, bool]:
    for bundle in bundles:
        if ACTIVE_PROVIDER_RESUME_MARKER in bundle.read_text(encoding="utf-8"):
            return False, True

    changed = False
    for bundle in bundles:
        text = bundle.read_text(encoding="utf-8")
        cleaned = RESUME_PROVIDER_OVERRIDE_RE.sub(r"\1.modelProvider", text)
        if cleaned != text:
            bundle.write_text(cleaned, encoding="utf-8")
            changed = True

    for bundle in bundles:
        text = bundle.read_text(encoding="utf-8")
        match = RESUME_PROVIDER_SITE_RE.search(text)
        if match is None:
            continue
        params_prefix, resume_params = match.group(1), match.group(2)
        replacement = (
            f"{params_prefix}"
            f"/* {ACTIVE_PROVIDER_RESUME_MARKER}:start */"
            f"({resume_params}.modelProvider{ACTIVE_PROVIDER_RESUME_SOURCE})"
            f"/* {ACTIVE_PROVIDER_RESUME_MARKER}:end */"
        )
        text = text[: match.start()] + replacement + text[match.end() :]
        bundle.write_text(text, encoding="utf-8")
        return True, True

    return changed, False


def arrow_body_end(text: str, brace: int) -> int | None:
    """Return the index past the arrow body opening at ``brace``."""
    depth = 0
    for index in range(brace, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return index + 1
    return None


def inject_usage_resets_bridge(bundles: list[Path]) -> tuple[bool, bool, Path | None]:
    """Expose the usage-reset modal opener so the sidebar pill can call it."""
    for bundle in bundles:
        if USAGE_RESETS_BRIDGE_MARKER in bundle.read_text(encoding="utf-8"):
            return False, True, bundle

    changed = False
    for bundle in bundles:
        text = bundle.read_text(encoding="utf-8")
        cleaned = USAGE_RESETS_OVERRIDE_RE.sub(r"\1", text)
        if cleaned != text:
            bundle.write_text(cleaned, encoding="utf-8")
            changed = True

    for bundle in bundles:
        text = bundle.read_text(encoding="utf-8")
        match = USAGE_RESETS_SITE_RE.search(text)
        if match is None:
            continue
        end = arrow_body_end(text, text.index("{", match.start()))
        if end is None:
            continue
        handler = match.group(1)
        arrow = text[match.start() + len(handler) + 1 : end]
        replacement = (
            f"{handler}=/* {USAGE_RESETS_BRIDGE_MARKER}:start */"
            f"(globalThis.__codexOpenUsageResets={arrow})"
            f"/* {USAGE_RESETS_BRIDGE_MARKER}:end */"
        )
        bundle.write_text(
            text[: match.start()] + replacement + text[end:], encoding="utf-8"
        )
        return True, True, bundle

    return changed, False, None


def version_metadata() -> dict[str, object]:
    """What the Codex Mod menu needs to know about this build and machine."""
    return {
        "version": local_release() or "0.0.0",
        "describe": repository_describe(),
        "commit": repository_head(),
        "subject": commit_subject(),
        "repoRoot": str(REPO_ROOT),
        "pythonPath": sys.executable,
        "agentLabel": manage_launch_agent.LABEL,
        "statePath": str(STATE_PATH),
        "checkRequestPath": str(CHECK_REQUEST_PATH),
        "configPath": str(CONFIG_PATH),
        "updateRequestPath": str(UPDATE_REQUEST_PATH),
        "uninstallRequestPath": str(UNINSTALL_REQUEST_PATH),
        "progressPath": str(PROGRESS_PATH),
        "errorLogPath": str(manage_launch_agent.LOG_DIR / "patch-error.log"),
    }


def inject_profile_switcher(extracted_dir: Path, node: Path) -> tuple[bool, Path]:
    package = json.loads((extracted_dir / "package.json").read_text(encoding="utf-8"))
    main_path = extracted_dir / package["main"]
    if not main_path.is_file():
        raise RuntimeError(f"main bundle is missing: {main_path}")

    module_path = main_path.parent / "codex-profile-switcher.cjs"
    source = PROFILE_SWITCHER_SOURCE.read_text(encoding="utf-8")
    subprocess.run([str(node), "--check", str(PROFILE_SWITCHER_SOURCE)], check=True)

    # A missing module means the extracted ASAR is a pristine Codex build, so
    # its backup is the one an uninstall must restore.
    was_pristine = not module_path.exists()
    changed = was_pristine or module_path.read_text(encoding="utf-8") != source
    if changed:
        module_path.write_text(source, encoding="utf-8")

    version_path = main_path.parent / "codex-mod-version.json"
    metadata = json.dumps(version_metadata(), indent=2, sort_keys=True) + "\n"
    if (
        not version_path.exists()
        or version_path.read_text(encoding="utf-8") != metadata
    ):
        version_path.write_text(metadata, encoding="utf-8")
        changed = True

    main_text = main_path.read_text(encoding="utf-8")
    if PROFILE_SWITCHER_MARKER not in main_text:
        main_text = PROFILE_SWITCHER_INJECTION_RE.sub("", main_text)
        injection = (
            '\n;try{require("./codex-profile-switcher.cjs").install()}'
            'catch(error){console.error("[codex-profile-switcher] install failed",error)}'
            f"/* {PROFILE_SWITCHER_MARKER} */\n"
        )
        main_path.write_text(main_text + injection, encoding="utf-8")
        changed = True
    return changed, was_pristine


def backup_asar(asar: Path, original_hash: str) -> Path:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    backup = BACKUP_DIR / f"app.asar.{original_hash[:16]}.bak"
    if not backup.exists():
        shutil.copy2(asar, backup)
    return backup


def permission_hint() -> str:
    """Name the process macOS holds responsible for bundle writes."""
    if os.getppid() == 1:
        responsible = sys.executable
    else:
        responsible = "the terminal application running this patcher"
    return (
        f"Grant App Management to {responsible} under "
        "System Settings > Privacy & Security > App Management, then run again."
    )


def bundle_writable(asar: Path) -> bool:
    """Whether the ASAR can be replaced, without doing the work to find out."""
    probe = asar.parent / f".{asar.name}.codex-desktop-patch-probe-{os.getpid()}"
    try:
        probe.touch()
    except OSError:
        return False
    finally:
        try:
            probe.unlink()
        except OSError:
            pass
    return True


def answer_permission_probe(asar: Path) -> None:
    """Report whether this launchd-spawned run can write the app bundle."""
    if not PROBE_REQUEST_PATH.exists():
        return
    try:
        PROBE_REQUEST_PATH.unlink()
    except OSError:
        pass
    result = {
        "executable": sys.executable,
        "app_management": bundle_writable(asar),
        "checked_at": time.time(),
    }
    try:
        PROBE_RESULT_PATH.write_text(json.dumps(result), encoding="utf-8")
    except OSError as error:
        print(f"[codex-desktop-patch] could not record probe result: {error}")


def verify_agent_permission() -> bool | None:
    """Whether the launch agent's python holds App Management, or None when
    the agent gave no answer.

    The interactive patch succeeds through the terminal's permission, so the
    agent itself must probe the bundle; otherwise the gap only surfaces when
    the first automatic update fails.
    """
    try:
        PROBE_RESULT_PATH.unlink()
    except OSError:
        pass
    try:
        PROBE_REQUEST_PATH.write_text("", encoding="utf-8")
    except OSError:
        return None
    print(
        "[codex-desktop-patch] checking the launch agent's App Management permission"
    )
    deadline = time.time() + 60
    last_kick = 0.0
    while time.time() < deadline:
        if PROBE_REQUEST_PATH.exists() and time.time() - last_kick >= 5:
            last_kick = time.time()
            manage_launch_agent.kickstart()
        elif not PROBE_REQUEST_PATH.exists() and PROBE_RESULT_PATH.exists():
            try:
                result = json.loads(PROBE_RESULT_PATH.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                break
            executable = result.get("executable") or sys.executable
            if result.get("app_management"):
                print(
                    "[codex-desktop-patch] launch agent verified: "
                    "automatic updates can modify the app"
                )
                return True
            print(
                "[codex-desktop-patch] the launch agent cannot modify the "
                "app, so automatic updates would fail.\n"
                f"[codex-desktop-patch] Grant App Management to {executable} "
                "under System Settings > Privacy & Security > App Management, "
                "then run again.",
                file=sys.stderr,
            )
            return False
        time.sleep(1)
    try:
        PROBE_REQUEST_PATH.unlink()
    except OSError:
        pass
    print(
        "[codex-desktop-patch] WARNING: could not verify the launch agent's "
        "App Management permission. If automatic updates fail, grant it to "
        f"{sys.executable} under System Settings > Privacy & Security > "
        "App Management.",
        file=sys.stderr,
    )
    return None


def replace_asar(asar: Path, packed_asar: Path, original_hash: str) -> None:
    if sha256(asar) != original_hash:
        raise RuntimeError(
            "Codex updated app.asar while it was being patched; run the patch again"
        )

    temporary_target = (
        asar.parent / f".{asar.name}.codex-desktop-patch-{os.getpid()}.tmp"
    )
    if temporary_target.exists():
        raise RuntimeError(
            f"refusing to overwrite unexpected temporary file: {temporary_target}"
        )

    try:
        shutil.copy2(packed_asar, temporary_target)
        os.replace(temporary_target, asar)
    except PermissionError as exc:
        raise PermissionError(
            f"permission denied while patching {asar}. Grant your terminal App Management "
            "permission, then run make patch again."
        ) from exc
    finally:
        if temporary_target.exists():
            temporary_target.unlink()


def main() -> int:
    # Line-buffered even when piped, so stdout keeps its order against the
    # unbuffered stderr in captured output and the agent's log files.
    sys.stdout.reconfigure(line_buffering=True)
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--asar", default=str(default_asar()), help="Path to Codex app.asar"
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--if-changed",
        action="store_true",
        help="Exit without patching when the ASAR and the newest remote release "
        "tag both match the last completed run",
    )
    parser.add_argument(
        "--version",
        default="latest",
        help="Release tag to install; 'latest' (the default) resolves the "
        "newest remote release, 'head' patches the current checkout. Ignored "
        "with --if-changed, whose runs update through git pull instead.",
    )
    parser.add_argument(
        "--uninstall",
        action="store_true",
        help="Restore the original app and remove the launch agent; runs the "
        "same uninstall the app's menu requests, but under the terminal's "
        "App Management grant",
    )
    parser.add_argument("--no-backup", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()

    asar = Path(args.asar).expanduser().resolve()
    if not asar.exists():
        print(f"[codex-desktop-patch] missing ASAR: {asar}")
        return 1

    if args.if_changed and not args.dry_run:
        answer_permission_probe(asar)

    if args.uninstall or (not args.dry_run and UNINSTALL_REQUEST_PATH.exists()):
        return uninstall_mod(asar)

    if UNINSTALLED_SENTINEL_PATH.exists():
        # Racing agent runs must not re-patch a freshly restored ASAR; only an
        # explicit make patch reinstalls.
        if args.if_changed:
            print("[codex-desktop-patch] codex-mod is uninstalled; skipping")
            return 0
        if not args.dry_run:
            UNINSTALLED_SENTINEL_PATH.unlink()

    # A check request only answers whether a newer release exists; the app
    # asks the user before requesting the actual install.
    if not args.dry_run and CHECK_REQUEST_PATH.exists():
        try:
            CHECK_REQUEST_PATH.unlink()
        except OSError:
            pass
        if args.if_changed:
            remote, reachable = remote_release()
            state = read_state()
            installed = state.get("release")
            if not reachable:
                stamp_state(
                    "check-failed",
                    remote,
                    reachable,
                    error="The update server could not be reached.",
                )
                print("[codex-desktop-patch] update check failed: remote unreachable")
            elif newer_release(remote, installed):
                stamp_state("update-available", remote, reachable)
                print(f"[codex-desktop-patch] update available: {remote}")
            elif state.get("result") == "failed":
                # Matching releases with a failed last run mean the install is
                # still broken, not up to date; keep surfacing the failure.
                error = state.get("error")
                stamp_state(
                    "failed",
                    remote,
                    reachable,
                    error=error if isinstance(error, str) else None,
                )
                print("[codex-desktop-patch] last patch run failed; not up to date")
            else:
                stamp_state("unchanged", remote, reachable)
                print("[codex-desktop-patch] no newer release")
            return 0

    update_requested = (
        UPDATE_REQUEST_PATH.exists()
        or os.environ.get("CODEX_MOD_UPDATE_REQUESTED") == "1"
    )
    if UPDATE_REQUEST_PATH.exists() and not args.dry_run:
        try:
            UPDATE_REQUEST_PATH.unlink()
        except OSError:
            pass

    # With automatic updates off only an explicit request from the app looks
    # for releases; WatchPaths and login runs then merely keep the installed
    # ASAR patched.
    updates_enabled = (
        not args.if_changed or update_requested or automatic_updates_enabled()
    )

    # The re-executed run has already decided there is work to do, and its own
    # guard would now see a settled release and skip the freshly pulled patch.
    restarted = os.environ.get("CODEX_MOD_PULLED") == "1"

    # Direct runs build a release tag; --if-changed runs instead fast-forward
    # the tracked branch below, because the agent keeps following main. The
    # release is installed by its own patcher as a subprocess, with only
    # arguments every release understands, and the branch is always restored.
    if not args.dry_run and not args.if_changed and not restarted:
        try:
            target = resolve_target_release(args.version)
        except RuntimeError as exc:
            print(f"[codex-desktop-patch] {exc}", file=sys.stderr)
            return 1
        if target is not None and tag_commit(target) != repository_head():
            current_branch = (run_git("rev-parse", "--abbrev-ref", "HEAD") or "").strip()
            previous_ref = (
                current_branch
                if current_branch and current_branch != "HEAD"
                else repository_head()
            )
            try:
                switch_to_release(target)
            except RuntimeError as exc:
                print(f"[codex-desktop-patch] {exc}", file=sys.stderr)
                return 1
            print(f"[codex-desktop-patch] building release {target}")
            try:
                child = subprocess.run(
                    [sys.executable, __file__, "--asar", str(asar)],
                    env=dict(os.environ, CODEX_MOD_PULLED="1"),
                )
                return child.returncode
            finally:
                if previous_ref:
                    run_git("checkout", previous_ref)

    remote, remote_reachable = (
        remote_release() if updates_enabled and not args.dry_run else (None, False)
    )
    if args.if_changed and not args.dry_run and not restarted:
        if not patch_work_pending(asar, remote):
            stamp_state("unchanged", remote, remote_reachable)
            print("[codex-desktop-patch] nothing changed since the last run")
            return 0

    # Only release tags trigger a pull; untagged upstream commits are never
    # installed automatically. Markers are derived from the sources at import
    # time, so a moved HEAD requires re-executing the patcher with the freshly
    # pulled sources.
    if (
        args.if_changed
        and not args.dry_run
        and not restarted
        and newer_release(remote, local_release())
    ):
        write_progress(10, "Downloading update")
        head_moved, pull_error = pull_patch_sources()
        if pull_error is not None:
            # A failed pull must not silently install stale sources; the only
            # exception is a changed ASAR, which still needs its repair patch.
            if asar_unchanged(asar, read_state()):
                message = f"release {remote} could not be downloaded: {pull_error}"
                print(f"[codex-desktop-patch] {message}", file=sys.stderr)
                stamp_state("failed", remote, remote_reachable, error=message)
                return 1
            print(
                f"[codex-desktop-patch] git pull failed ({pull_error}); "
                "repairing the changed ASAR with local sources"
            )
        if head_moved:
            print("[codex-desktop-patch] sources updated; restarting patcher")
            os.environ["CODEX_MOD_PULLED"] = "1"
            if update_requested:
                os.environ["CODEX_MOD_UPDATE_REQUESTED"] = "1"
            os.execv(sys.executable, [sys.executable, __file__, *sys.argv[1:]])

    if not PROFILE_SWITCHER_SOURCE.is_file():
        print(
            f"[codex-desktop-patch] missing profile switcher: {PROFILE_SWITCHER_SOURCE}",
            file=sys.stderr,
        )
        return 1
    if not args.dry_run:
        refresh_launch_agent(asar)
        # Verified before patching, because a patch the agent cannot keep
        # updated only breaks later, on the first automatic update.
        if not args.if_changed and verify_agent_permission() is False:
            message = (
                "the launch agent's python lacks App Management; not patching"
            )
            print(f"[codex-desktop-patch] {message}", file=sys.stderr)
            record_state(asar, remote, remote_reachable, "failed", error=message)
            return 1

    # Checked up front, because the write only happens after a full extract
    # and repack, and a missing permission is otherwise reported a minute late.
    writable = bundle_writable(asar)
    if not writable and not args.dry_run:
        print(
            f"[codex-desktop-patch] cannot write to {asar.parent}\n"
            f"[codex-desktop-patch] {permission_hint()}",
            file=sys.stderr,
        )
        record_state(asar, remote, remote_reachable, "failed", error=permission_hint())
        return 1

    node = find_node(asar)
    original_hash = sha256(asar)

    try:
        with tempfile.TemporaryDirectory(
            prefix="codex-desktop-patch-"
        ) as temp_dir_name:
            temp_dir = Path(temp_dir_name)
            extracted_dir = temp_dir / "app"
            packed_asar = temp_dir / "app.asar"
            if not args.dry_run:
                write_progress(20, "Extracting application")
            run_asar(node, "extract", asar, extracted_dir)
            if not args.dry_run:
                write_progress(50, "Applying patches")

            renderers = renderer_bundles(extracted_dir)
            history_replacements, lists_all_providers = patch_provider_history(
                javascript_bundles(extracted_dir)
            )
            bridge_changed, bridge_ready = inject_profile_restart_bridge(renderers)
            dispatch_removals = remove_profile_switch_dispatch(
                javascript_bundles(extracted_dir)
            )
            resume_changed, resume_ready = inject_active_provider_resume(renderers)
            resets_changed, resets_ready, resets_bundle = inject_usage_resets_bridge(
                renderers
            )
            bridge_bundle = profile_restart_bridge_bundle(renderers)
            for checked in {bridge_bundle, resets_bundle if resets_changed else None}:
                if checked is not None:
                    check_javascript(node, checked)
            profile_changed, asar_was_pristine = inject_profile_switcher(
                extracted_dir, node
            )
            changed = (
                history_replacements > 0
                or bridge_changed
                or dispatch_removals > 0
                or resume_changed
                or resets_changed
                or profile_changed
            )

            print(f"[codex-desktop-patch] target: {asar}")
            print(
                "[codex-desktop-patch] release: "
                + (local_release() or "untagged")
                + (
                    f" ({repository_describe()})"
                    if repository_describe() != local_release()
                    else ""
                )
            )
            if args.dry_run:
                print(
                    "[codex-desktop-patch] bundle writable: "
                    + ("yes" if writable else f"no; {permission_hint()}")
                )
            print(
                "[codex-desktop-patch] provider history: "
                + (
                    f"{history_replacements} replacement(s)"
                    if history_replacements
                    else "already provider-wide"
                )
            )
            print(
                "[codex-desktop-patch] active-provider resume: "
                + (
                    "would install"
                    if resume_changed and args.dry_run
                    else "installing"
                    if resume_changed
                    else "ready"
                    if resume_ready
                    else "not detected"
                )
            )
            print(
                "[codex-desktop-patch] usage reset bridge: "
                + (
                    "would install"
                    if resets_changed and args.dry_run
                    else "installing"
                    if resets_changed
                    else "ready"
                    if resets_ready
                    # The usage bar still renders; only the reset pill is lost.
                    else "not detected; reset pill disabled"
                )
            )
            print(
                "[codex-desktop-patch] profile switcher: "
                + (
                    "would install"
                    if profile_changed and args.dry_run
                    else "installing"
                    if profile_changed
                    else "ready"
                )
            )
            print(
                "[codex-desktop-patch] seamless profile restart: "
                + (
                    "would install"
                    if bridge_changed and args.dry_run
                    else "installing"
                    if bridge_changed
                    else "ready"
                    if bridge_ready
                    else "full relaunch fallback"
                )
            )
            print(
                "[codex-desktop-patch] sidebar profile control: "
                + (
                    "would install"
                    if (profile_changed or dispatch_removals) and args.dry_run
                    else "installing"
                    if profile_changed or dispatch_removals
                    else "ready"
                )
            )
            if not lists_all_providers:
                raise RuntimeError(
                    "provider-wide recent and archived thread listing was not detected"
                )
            if not resume_ready:
                raise RuntimeError(
                    "the active-provider resume override was not installed"
                )
            if not changed:
                # A run that ends still behind the newest release must not
                # read as up to date; the pull above failed to reach the tag.
                if (
                    args.if_changed
                    and not args.dry_run
                    and newer_release(remote, local_release())
                ):
                    message = (
                        f"release {remote} is available, but the patch sources "
                        "could not be updated to it. Run make patch in the "
                        "repository."
                    )
                    print(f"[codex-desktop-patch] {message}", file=sys.stderr)
                    record_state(asar, remote, remote_reachable, "failed", error=message)
                    return 1
                print("[codex-desktop-patch] already patched")
                if not args.dry_run:
                    record_state(asar, remote, remote_reachable, "unchanged")
                return 0
            if args.dry_run:
                print("[codex-desktop-patch] dry run complete; no files changed")
                return 0

            write_progress(65, "Repacking application")
            pack_asar(node, asar, extracted_dir, packed_asar)
            run_asar(node, "list", packed_asar)
            write_progress(90, "Installing")
            backup = None if args.no_backup else backup_asar(asar, original_hash)
            replace_asar(asar, packed_asar, original_hash)
            write_progress(100, "Finished")
            record_state(
                asar,
                remote,
                remote_reachable,
                "updated",
                extra=(
                    {"original_backup": str(backup)}
                    if asar_was_pristine and backup is not None
                    else None
                ),
            )

            print(f"[codex-desktop-patch] patched: {asar}")
            if backup is not None:
                print(f"[codex-desktop-patch] backup: {backup}")
            print(
                "[codex-desktop-patch] restart Codex Desktop for changes to take effect"
            )
            return 0
    except (OSError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"[codex-desktop-patch] failed: {exc}", file=sys.stderr)
        if not args.dry_run:
            record_state(asar, remote, remote_reachable, "failed", error=str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
