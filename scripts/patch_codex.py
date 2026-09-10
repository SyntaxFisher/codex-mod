#!/usr/bin/env python3
"""Tooling for the Codex mod host: patched renderer bundles, update checks and uninstall.

The installed application is never modified. The renderer bundles are patched
into a cache directory that the host serves over the DevTools protocol, and
the only bundle write left is the restore of an app.asar that an earlier
release of the mod patched in place.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from typing import Callable

import manage_launch_agent


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
CODEX_HOME = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
RENDERER_CACHE_DIR = CODEX_HOME / ".codex-mod-renderer-cache"
LAUNCH_WATCHER_SOURCE = SCRIPT_DIR / "launch_watcher.m"
LAUNCH_WATCHER = REPO_ROOT / "build/launch-watcher"
# {"automaticUpdates": false} turns the host's release check off.
CONFIG_PATH = CODEX_HOME / ".codex-mod-config.json"

DEFAULT_ASAR_CANDIDATES = (
    Path("/Applications/ChatGPT.app/Contents/Resources/app.asar"),
    Path("/Applications/Codex.app/Contents/Resources/app.asar"),
)

# Releases before 2.0.0 patched app.asar in place. They kept the pristine
# archive under BACKUP_DIR, recorded which backup that was in STATE_PATH,
# installed an npm dependency into the checkout, and talked to their launch
# agent through marker files.
LEGACY_PATCH_ENTRY = "codex-profile-switcher.cjs"
BACKUP_DIR = CODEX_HOME / "backups/codex-app-asar"
STATE_PATH = CODEX_HOME / ".codex-mod-state.json"
LEGACY_PATHS = (
    STATE_PATH,
    REPO_ROOT / "node_modules",
    *(
        CODEX_HOME / name
        for name in (
            ".codex-mod-check-request",
            ".codex-mod-update-request",
            ".codex-mod-uninstall-request",
            ".codex-mod-uninstalled",
            ".codex-mod-probe-request",
            ".codex-mod-probe.json",
            ".codex-mod-progress.json",
        )
    ),
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

PROFILE_RESTART_DISPATCH_RE = re.compile(
    rf"function {IDENT}\(({IDENT})\)\{{({IDENT})\.dispatchMessage\("
    r"`codex-app-server-restart`,\{hostId:\1,intent:`restart`,errorMessage:null\}\)\}"
)

ACTIVE_PROVIDER_RESUME_SOURCE = (
    "??(()=>{try{let p=localStorage.getItem(`__codex_active_provider`);"
    "return typeof p==`string`&&p.length>0?p:null}catch{return null}})()"
)

RESUME_PROVIDER_SITE_RE = re.compile(
    rf"((?:sendRequest\(`thread/resume`,\{{|\{{threadId:{IDENT},history:)"
    rf"[^;]{{0,400}}?modelProvider:)"
    rf"({IDENT})\.modelProvider(?=,)"
)

USAGE_RESETS_SITE_RE = re.compile(
    rf"({IDENT})=\(\)=>\{{(?=[^{{}}]*\{{defaultResetCreditsOpen:!0)"
)

# The query behind the app's own usage display: its fetcher returns the parsed
# /wham/usage response, which the bridge hands to the sidebar as well.
RATE_LIMIT_STATUS_SITE_RE = re.compile(
    rf"(queryKey:\[`rate-limit-status`\],(?:[^{{}}]{{0,120}},)?queryFn:async\(\)=>\{{try\{{"
    rf".{{0,900}}?return {IDENT}\({IDENT},({IDENT})\),)\2\}}",
    re.DOTALL,
)

# The window's root scope, read by the error boundary that wraps every
# route, and the action behind "Edit message" on the last user turn. The
# host resends a failed message through that action so Codex replaces the
# failed turn instead of appending a second copy.
ROOT_SCOPE_SITE_RE = re.compile(
    rf"(function {IDENT}\({IDENT}\)\{{let {IDENT}=\(0,{IDENT}\.c\)\(\d+\),"
    rf"\{{children:{IDENT}\}}={IDENT},({IDENT})=)({IDENT}\({IDENT}\))"
    rf"(?=,.{{0,600}}?\2\.get\({IDENT}\)\.forEach\({IDENT}\))"
)

EDIT_LAST_TURN_SITE_RE = re.compile(
    rf"async function ({IDENT})\(({IDENT}),({IDENT}),({IDENT}),({IDENT})\)\{{"
    rf"[^{{}}]{{0,200}}?\.editLastUserTurn\(\4,\{{\.\.\.\5,[^{{}}]*\}}\)\}}"
)

VERSION_TAG_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")


def log(message: str, error: bool = False) -> None:
    print(f"[codex-desktop-patch] {message}", file=sys.stderr if error else sys.stdout)


def parse_version(tag: str) -> tuple[int, int, int] | None:
    match = VERSION_TAG_RE.match(tag.strip())
    if match is None:
        return None
    major, minor, patch = match.groups()
    return (int(major), int(minor), int(patch))


# The reason the last git command failed, so the host can report why the
# remote is unreachable instead of staying silent.
last_git_error: str | None = None


def run_git(*args: str, timeout: float | None = None) -> str | None:
    global last_git_error
    try:
        result = subprocess.run(
            ["git", "-C", str(REPO_ROOT), *args],
            text=True,
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        last_git_error = f"git {args[0]} timed out"
        return None
    except OSError as error:
        last_git_error = f"git could not run: {error}"
        return None
    if result.returncode != 0:
        detail = (result.stderr.strip() or result.stdout.strip()).splitlines()
        last_git_error = f"git {args[0]} failed: {detail[-1] if detail else result.returncode}"
        return None
    return result.stdout


def repository_head() -> str | None:
    output = run_git("rev-parse", "HEAD")
    return output.strip() if output else None


def repository_describe() -> str | None:
    output = run_git("describe", "--tags", "--always", "--dirty")
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


def newer_release(candidate: str | None, baseline: str | None) -> bool:
    parsed = parse_version(candidate) if candidate is not None else None
    if parsed is None:
        return False
    baseline_parsed = parse_version(baseline) if baseline is not None else None
    return baseline_parsed is None or parsed > baseline_parsed


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


def automatic_updates_enabled() -> bool:
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return True
    return not isinstance(config, dict) or config.get("automaticUpdates") is not False


def update_status() -> dict[str, object]:
    """What the host needs to decide whether a newer release is available."""
    remote, reachable = remote_release()
    remote_error = None if reachable else last_git_error
    local = local_release()
    return {
        "local_release": local,
        "remote_release": remote,
        "remote_reachable": reachable,
        "remote_error": remote_error,
        "update_available": reachable and newer_release(remote, local),
        "head": repository_head(),
        "describe": repository_describe(),
        "automatic_updates": automatic_updates_enabled(),
    }


def default_asar() -> Path:
    return next(
        (path for path in DEFAULT_ASAR_CANDIDATES if path.exists()),
        DEFAULT_ASAR_CANDIDATES[0],
    )


class Asar:
    """Read-only view of an Electron archive through its header.

    Reading the few files the mod needs straight from the archive avoids
    extracting hundreds of megabytes for every cache build.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        with path.open("rb") as handle:
            pickle_size = struct.unpack("<I", handle.read(8)[4:8])[0]
            pickle = handle.read(pickle_size)
        header_length = struct.unpack("<I", pickle[4:8])[0]
        self.header_json = pickle[8 : 8 + header_length]
        self.header = json.loads(self.header_json)
        self.data_start = 8 + pickle_size

    @property
    def header_sha256(self) -> str:
        """Electron's integrity check compares this hash, so it identifies the build."""
        return hashlib.sha256(self.header_json).hexdigest()

    def entry(self, archive_path: str) -> dict | None:
        node = self.header
        for part in archive_path.split("/"):
            node = node.get("files", {}).get(part)
            if node is None:
                return None
        return node

    def contains(self, file_name: str) -> bool:
        """Whether a file of that name exists anywhere in the archive."""

        def walk(node: dict) -> bool:
            children = node.get("files", {})
            return file_name in children or any(walk(child) for child in children.values())

        return walk(self.header)

    def read(self, archive_path: str) -> bytes:
        entry = self.entry(archive_path)
        if entry is None or "offset" not in entry:
            raise RuntimeError(f"{archive_path} is not packed into {self.path}")
        with self.path.open("rb") as handle:
            handle.seek(self.data_start + int(entry["offset"]))
            return handle.read(entry["size"])

    def files(self, directory: str, suffix: str) -> dict[str, bytes]:
        """The packed files of one archive directory, by name."""
        entry = self.entry(directory) or {}
        files = {}
        with self.path.open("rb") as handle:
            for name, child in sorted(entry.get("files", {}).items()):
                if name.endswith(suffix) and "offset" in child:
                    handle.seek(self.data_start + int(child["offset"]))
                    files[name] = handle.read(child["size"])
        return files

    def package_version(self) -> str | None:
        try:
            version = json.loads(self.read("package.json")).get("version")
        except (RuntimeError, OSError, ValueError):
            return None
        return version if isinstance(version, str) else None


class Bundle:
    """A renderer bundle held in memory while the patches run over it."""

    def __init__(self, name: str, text: str) -> None:
        self.name = name
        self.original = text
        self.text = text

    @property
    def changed(self) -> bool:
        return self.text != self.original


def patch_provider_history(bundles: list[Bundle]) -> bool:
    """List recent and archived threads across providers; report whether both took."""
    recent_provider_wide = False
    archived_provider_wide = False
    for bundle in bundles:
        if "modelProviders:" not in bundle.text:
            continue
        text = ALL_PROVIDER_NULL_RE.sub("modelProviders:[]", bundle.text)
        text = RECENT_PROVIDER_FILTER_RE.sub(r"\1[]", text)
        text = ARCHIVED_PROVIDER_FILTER_RE.sub(r"\1[]", text)
        bundle.text = text
        recent_provider_wide |= RECENT_PROVIDER_WIDE_RE.search(text) is not None
        archived_provider_wide |= ARCHIVED_PROVIDER_WIDE_RE.search(text) is not None
    return recent_provider_wide and archived_provider_wide


def inject_profile_restart_bridge(bundles: list[Bundle]) -> bool:
    """Expose the app-server restart so a provider switch needs no relaunch."""
    preferred = sorted(bundles, key=lambda b: (not b.name.startswith("app-initial-"), b.name))
    for bundle in preferred:
        match = PROFILE_RESTART_DISPATCH_RE.search(bundle.text)
        if match is None:
            continue
        bridge = match.group(2)
        injection = (
            ";globalThis.__codexProfileRestart=()=>{"
            f"{bridge}.dispatchMessage(`codex-app-server-restart`,"
            "{hostId:`local`,intent:`restart`});return!0};"
        )
        bundle.text = bundle.text[: match.end()] + injection + bundle.text[match.end() :]
        return True
    return False


def inject_active_provider_resume(bundles: list[Bundle]) -> bool:
    """Resume threads under the active provider instead of the one they were started with."""
    for bundle in bundles:
        match = RESUME_PROVIDER_SITE_RE.search(bundle.text)
        if match is None:
            continue
        params_prefix, resume_params = match.group(1), match.group(2)
        replacement = (
            f"{params_prefix}({resume_params}.modelProvider{ACTIVE_PROVIDER_RESUME_SOURCE})"
        )
        bundle.text = bundle.text[: match.start()] + replacement + bundle.text[match.end() :]
        return True
    return False


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


def inject_usage_resets_bridge(bundles: list[Bundle]) -> bool:
    """Expose the usage-reset modal opener so the sidebar pill can call it."""
    for bundle in bundles:
        text = bundle.text
        match = USAGE_RESETS_SITE_RE.search(text)
        if match is None:
            continue
        end = arrow_body_end(text, text.index("{", match.start()))
        if end is None:
            continue
        handler = match.group(1)
        arrow = text[match.start() + len(handler) + 1 : end]
        replacement = f"{handler}=(globalThis.__codexOpenUsageResets={arrow})"
        bundle.text = text[: match.start()] + replacement + text[end:]
        return True
    return False


def inject_rate_limit_status_bridge(bundles: list[Bundle]) -> bool:
    """Report each usage response the app fetches for its own display."""
    for bundle in bundles:
        text, count = RATE_LIMIT_STATUS_SITE_RE.subn(
            r"\1globalThis.__codexReportRateLimits?.(\2),\2}", bundle.text, count=1
        )
        if count == 1:
            bundle.text = text
            return True
    return False


def inject_edit_last_turn_bridge(bundles: list[Bundle]) -> bool:
    """Expose the edit-last-turn action so the host can resend a failed message in place."""
    for bundle in bundles:
        scope = ROOT_SCOPE_SITE_RE.search(bundle.text)
        action = EDIT_LAST_TURN_SITE_RE.search(bundle.text)
        if scope is None or action is None:
            continue
        text = bundle.text
        hook = (
            f";globalThis.__codexEditLastTurn=(e,t)=>{action.group(1)}"
            "(globalThis.__codexScope,`local`,e,t);"
        )
        text = text[: action.end()] + hook + text[action.end() :]
        text = (
            text[: scope.start()]
            + f"{scope.group(1)}(globalThis.__codexScope={scope.group(3)})"
            + text[scope.end() :]
        )
        bundle.text = text
        return True
    return False


def check_javascript(node: Path, bundle: Path) -> None:
    result = subprocess.run([str(node), "--check", str(bundle)], text=True, capture_output=True)
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(f"JavaScript syntax check failed for {bundle.name}: {detail}")


def build_renderer_cache(asar: Path, cache_dir: Path) -> None:
    """Write the patched renderer bundles for ``asar`` into ``cache_dir``.

    Only bundles the patches change are written; the manifest names them
    together with the archive header hash and patcher commit they belong to,
    so a cache built from the same pair is reused.
    """
    archive = Asar(asar)
    if archive.contains(LEGACY_PATCH_ENTRY):
        raise RuntimeError(
            f"{asar} is patched by an earlier release; run make install to restore it"
        )
    manifest_path = cache_dir / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        manifest = None
    if (
        isinstance(manifest, dict)
        and manifest.get("asar_header_sha256") == archive.header_sha256
        and manifest.get("patcher_head") == repository_head()
        and all((cache_dir / name).is_file() for name in manifest.get("files", []))
    ):
        log(f"renderer cache is current: {cache_dir}")
        return

    files = archive.files("webview/assets", ".js")
    if not files:
        raise RuntimeError("no Codex renderer bundles were found")
    bundles = [Bundle(name, data.decode("utf-8")) for name, data in files.items()]
    if not patch_provider_history(bundles):
        raise RuntimeError("provider-wide recent and archived thread listing was not detected")
    if not inject_active_provider_resume(bundles):
        raise RuntimeError("the active-provider resume override was not installed")
    # The host relaunches Codex and hides the resets pill when these bridges
    # are missing, so a changed Codex build degrades instead of failing.
    if not inject_profile_restart_bridge(bundles):
        log("profile restart bridge not found; provider switches relaunch Codex")
    if not inject_usage_resets_bridge(bundles):
        log("usage resets bridge not found; the resets pill stays hidden")
    if not inject_rate_limit_status_bridge(bundles):
        log("rate limit status bridge not found; usage refreshes from the poll only")
    if not inject_edit_last_turn_bridge(bundles):
        log("edit bridge not found; a failed message is sent again through the composer")
    changed = [bundle for bundle in bundles if bundle.changed]

    # The patched bundles are staged and syntax-checked before they replace
    # the cache, so a failed check leaves the previous cache in place.
    node = manage_launch_agent.resolve_node(None)
    with tempfile.TemporaryDirectory(prefix="codex-desktop-renderer-") as temp_dir_name:
        staging = Path(temp_dir_name)
        for bundle in changed:
            (staging / bundle.name).write_text(bundle.text, encoding="utf-8")
            check_javascript(node, staging / bundle.name)
        cache_dir.mkdir(parents=True, exist_ok=True)
        for stale in cache_dir.glob("*.js"):
            stale.unlink()
        for bundle in changed:
            shutil.move(staging / bundle.name, cache_dir / bundle.name)
    manifest = {
        "asar": str(asar),
        "asar_header_sha256": archive.header_sha256,
        "patcher_head": repository_head(),
        "version": local_release() or "0.0.0",
        "describe": repository_describe(),
        "files": sorted(bundle.name for bundle in changed),
        "built_at": time.time(),
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    log(f"renderer cache: {len(changed)} patched bundle(s) in {cache_dir}")


def build_launch_watcher() -> None:
    """Compile the helper that reports Codex launches to the host."""
    if (
        LAUNCH_WATCHER.is_file()
        and LAUNCH_WATCHER.stat().st_mtime >= LAUNCH_WATCHER_SOURCE.stat().st_mtime
    ):
        return
    LAUNCH_WATCHER.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [
            "clang",
            "-fobjc-arc",
            "-framework",
            "AppKit",
            "-O2",
            "-o",
            str(LAUNCH_WATCHER),
            str(LAUNCH_WATCHER_SOURCE),
        ],
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"building the launch watcher failed: {result.stderr.strip()}")
    log(f"built {LAUNCH_WATCHER}")


def find_original_backup(archive: Asar) -> Path | None:
    """The pristine backup of the installed Codex build, if one is known."""
    try:
        recorded = json.loads(STATE_PATH.read_text(encoding="utf-8")).get("original_backup")
    except (OSError, ValueError, AttributeError):
        recorded = None
    if isinstance(recorded, str) and Path(recorded).is_file():
        return Path(recorded)

    # Installs that predate the record are matched by Codex version instead.
    current_version = archive.package_version()
    if current_version is None or not BACKUP_DIR.is_dir():
        return None
    backups = sorted(
        BACKUP_DIR.glob("app.asar.*.bak"),
        key=lambda backup: backup.stat().st_mtime,
        reverse=True,
    )
    for backup in backups:
        try:
            candidate = Asar(backup)
        except (OSError, ValueError, struct.error):
            continue
        if (
            not candidate.contains(LEGACY_PATCH_ENTRY)
            and candidate.package_version() == current_version
        ):
            return backup
    return None


def replace_file(target: Path, write: Callable[[Path], None]) -> None:
    """Replace ``target`` atomically with what ``write`` puts into a sibling file."""
    temporary = target.parent / f".{target.name}.codex-desktop-patch-{os.getpid()}.tmp"
    try:
        write(temporary)
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            temporary.unlink()


def sync_asar_integrity(asar: Path) -> None:
    """Point the bundle's ElectronAsarIntegrity entry back at the restored archive.

    Codex ships with Electron's EnableEmbeddedAsarIntegrityValidation fuse on,
    so an Info.plist hash that does not match the archive header aborts the
    app during startup.
    """
    bundle = asar.parent.parent.parent
    plist = bundle / "Contents/Info.plist"
    if bundle.suffix != ".app" or not plist.is_file():
        return
    with plist.open("rb") as handle:
        binary = handle.read(6) == b"bplist"
        handle.seek(0)
        info = plistlib.load(handle)
    integrity = info.get("ElectronAsarIntegrity")
    entry = (
        integrity.get(asar.relative_to(bundle / "Contents").as_posix())
        if isinstance(integrity, dict)
        else None
    )
    digest = Asar(asar).header_sha256
    if not isinstance(entry, dict) or entry.get("hash") == digest:
        return
    entry["algorithm"] = "SHA256"
    entry["hash"] = digest

    def write(temporary: Path) -> None:
        with temporary.open("wb") as handle:
            plistlib.dump(
                info,
                handle,
                fmt=plistlib.FMT_BINARY if binary else plistlib.FMT_XML,
                sort_keys=False,
            )
        shutil.copymode(plist, temporary)

    replace_file(plist, write)


def restore_patched_asar(asar: Path) -> None:
    """Put back the pristine app.asar if an earlier release patched it in place.

    This is the only write into the application bundle left in the mod and
    therefore the only step that needs App Management.
    """
    archive = Asar(asar)
    if not archive.contains(LEGACY_PATCH_ENTRY):
        return
    backup = find_original_backup(archive)
    if backup is None:
        raise RuntimeError(
            f"{asar} was patched by an earlier release and no pristine backup "
            "was found; reinstall Codex to restore it"
        )
    try:
        replace_file(asar, lambda temporary: shutil.copy2(backup, temporary))
        sync_asar_integrity(asar)
    except PermissionError as exc:
        raise RuntimeError(
            f"cannot restore {asar}: grant App Management to the terminal "
            "application under System Settings > Privacy & Security, then run "
            "the command again"
        ) from exc
    log(f"restored original ASAR from {backup}")


def remove_files(*paths: Path) -> None:
    for path in paths:
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        else:
            try:
                path.unlink()
            except OSError:
                continue


def install_mod(asar: Path, cache_dir: Path, install_agent: bool) -> None:
    """Build what the host needs; with ``install_agent`` also start the host.

    The launch agent of releases before 2.0.0 re-executes the patcher after
    pulling a release with no Makefile around to install the host agent, so
    that run installs it here. Installing the agent ends with launchd
    stopping the legacy agent, and with it that very process, which is why
    it is the last step.
    """
    restore_patched_asar(asar)
    build_renderer_cache(asar, cache_dir)
    build_launch_watcher()
    remove_files(*LEGACY_PATHS)
    if install_agent:
        manage_launch_agent.install(manage_launch_agent.resolve_node(None))


def uninstall_mod(asar: Path, cache_dir: Path) -> None:
    """Stop the host, drop its cache and restore an app.asar patched in place."""
    manage_launch_agent.uninstall()
    restore_patched_asar(asar)
    shutil.rmtree(cache_dir, ignore_errors=True)
    remove_files(*LEGACY_PATHS, CONFIG_PATH)
    log("uninstalled; Codex keeps running without the mod")


def main() -> int:
    sys.stdout.reconfigure(line_buffering=True)
    parser = argparse.ArgumentParser()
    parser.add_argument("--asar", default=str(default_asar()), help="Path to Codex app.asar")
    parser.add_argument(
        "--renderer-cache",
        metavar="DIR",
        default=str(RENDERER_CACHE_DIR),
        help="Directory receiving the patched renderer bundles the host serves",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate the patches against the installed Codex build without "
        "writing the cache",
    )
    parser.add_argument(
        "--uninstall",
        action="store_true",
        help="Remove the launch agent and cache, and restore an app.asar that "
        "an earlier release patched in place",
    )
    parser.add_argument(
        "--update-status",
        action="store_true",
        help="Print the local and newest remote release as JSON",
    )
    parser.add_argument(
        "--pull",
        action="store_true",
        help="Fast-forward the checkout to the remote and print whether HEAD moved",
    )
    # Passed by the launch agent of releases that patched the application in
    # place when it re-executes the patcher after pulling this release.
    parser.add_argument("--if-changed", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()

    if args.update_status:
        print(json.dumps(update_status()))
        return 0
    if args.pull:
        moved, error = pull_patch_sources()
        print(json.dumps({"moved": moved, "error": error, "describe": repository_describe()}))
        return 0 if error is None else 1

    asar = Path(args.asar).expanduser().resolve()
    if not asar.exists():
        log(f"missing ASAR: {asar}", error=True)
        return 1
    cache_dir = Path(args.renderer_cache).expanduser()

    try:
        if args.uninstall:
            uninstall_mod(asar, cache_dir)
        elif args.dry_run:
            with tempfile.TemporaryDirectory(prefix="codex-desktop-dry-run-") as temp_dir:
                build_renderer_cache(asar, Path(temp_dir))
            log("dry run complete; no files changed")
        else:
            install_mod(asar, cache_dir, install_agent=args.if_changed)
        return 0
    except (OSError, RuntimeError, ValueError, struct.error) as exc:
        log(f"failed: {exc}", error=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
