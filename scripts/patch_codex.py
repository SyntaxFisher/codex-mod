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

import manage_launch_agent


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
CODEX_HOME = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
ASAR_CLI = REPO_ROOT / "node_modules/@electron/asar/bin/asar.mjs"
BACKUP_DIR = CODEX_HOME / "backups/codex-app-asar"
RENDERER_CACHE_DIR = CODEX_HOME / ".codex-mod-renderer-cache"
LAUNCH_WATCHER_SOURCE = SCRIPT_DIR / "launch_watcher.m"
LAUNCH_WATCHER = REPO_ROOT / "build/launch-watcher"
STATE_PATH = CODEX_HOME / ".codex-mod-state.json"
# Written by the Automatic Updates setting and read on every update check.
CONFIG_PATH = CODEX_HOME / ".codex-mod-config.json"
# Marker files earlier releases used to talk to their launch agent.
LEGACY_PATHS = tuple(
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
)

def content_marker(name: str, content: str) -> str:
    fingerprint = hashlib.sha256(content.encode()).hexdigest()[:12]
    return f"{name}:{fingerprint}"

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

PROFILE_RESTART_DISPATCH_RE = re.compile(
    rf"function {IDENT}\(({IDENT})\)\{{({IDENT})\.dispatchMessage\("
    r"`codex-app-server-restart`,\{hostId:\1,intent:`restart`,errorMessage:null\}\)\}"
)

PROFILE_RESTART_BRIDGE_INJECTION_RE = re.compile(
    r";globalThis\.__codexProfileRestart=.*?"
    r"/\* codex-profile-restart-bridge:(?:v\d+|[0-9a-f]+) \*/"
)

ACTIVE_PROVIDER_RESUME_SOURCE = (
    "??(()=>{try{let p=localStorage.getItem(`__codex_active_provider`);"
    "return typeof p==`string`&&p.length>0?p:null}catch{return null}})()"
)

ACTIVE_PROVIDER_RESUME_MARKER = content_marker(
    "codex-active-provider-resume", ACTIVE_PROVIDER_RESUME_SOURCE
)

RESUME_PROVIDER_SITE_RE = re.compile(
    rf"((?:sendRequest\(`thread/resume`,\{{|\{{threadId:{IDENT},history:)"
    rf"[^;]{{0,400}}?modelProvider:)"
    rf"({IDENT})\.modelProvider(?=,)"
)

USAGE_RESETS_BRIDGE_SOURCE = "globalThis.__codexOpenUsageResets=<handler>"

USAGE_RESETS_BRIDGE_MARKER = content_marker(
    "codex-usage-resets-bridge", USAGE_RESETS_BRIDGE_SOURCE
)

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

def build_renderer_cache(asar: Path, cache_dir: Path) -> int:
    """Write the patched renderer bundles for ``asar`` into ``cache_dir``.

    The external host serves these over the DevTools protocol instead of
    repacking the archive, so the installed bundle and its code signature stay
    untouched. Only bundles the patches actually change are written; the
    manifest names them together with the archive header hash they belong to.
    """
    node = find_node(asar)
    header_digest = asar_header_sha256(asar)
    manifest_path = cache_dir / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        manifest = None
    if (
        isinstance(manifest, dict)
        and manifest.get("asar_header_sha256") == header_digest
        and manifest.get("patcher_head") == repository_head()
        and all((cache_dir / name).is_file() for name in manifest.get("files", []))
    ):
        print(f"[codex-desktop-patch] renderer cache is current: {cache_dir}")
        return 0

    with tempfile.TemporaryDirectory(prefix="codex-desktop-renderer-") as temp_dir_name:
        extracted_dir = Path(temp_dir_name) / "app"
        run_asar(node, "extract", asar, extracted_dir)
        renderers = renderer_bundles(extracted_dir)
        originals = {bundle: bundle.read_bytes() for bundle in renderers}

        _, lists_all_providers = patch_provider_history(renderers)
        _, bridge_ready = inject_profile_restart_bridge(renderers)
        _, resume_ready = inject_active_provider_resume(renderers)
        _, resets_ready, resets_bundle = inject_usage_resets_bridge(renderers)
        if not lists_all_providers:
            raise RuntimeError(
                "provider-wide recent and archived thread listing was not detected"
            )
        if not resume_ready:
            raise RuntimeError("the active-provider resume override was not installed")
        for checked in {profile_restart_bridge_bundle(renderers), resets_bundle}:
            if checked is not None:
                check_javascript(node, checked)

        changed = [bundle for bundle in renderers if bundle.read_bytes() != originals[bundle]]
        cache_dir.mkdir(parents=True, exist_ok=True)
        for stale in cache_dir.glob("*.js"):
            stale.unlink()
        for bundle in changed:
            shutil.copyfile(bundle, cache_dir / bundle.name)
        manifest = {
            "asar": str(asar),
            "asar_header_sha256": header_digest,
            "patcher_head": repository_head(),
            "version": local_release() or "0.0.0",
            "describe": repository_describe(),
            "files": sorted(bundle.name for bundle in changed),
            "seamless_restart": bridge_ready,
            "usage_resets": resets_ready,
            "built_at": time.time(),
        }
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(
        f"[codex-desktop-patch] renderer cache: {len(changed)} patched bundle(s) in {cache_dir}"
    )
    return 0

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

def application_bundle(asar: Path) -> Path | None:
    bundle = asar.parent.parent.parent
    return bundle if bundle.suffix == ".app" else None

def asar_header_sha256(asar: Path) -> str:
    """Hash of the header JSON, which is what Electron's integrity check compares."""
    with asar.open("rb") as handle:
        header_pickle_size = struct.unpack("<I", handle.read(8)[4:8])[0]
        header_pickle = handle.read(header_pickle_size)
    header_length = struct.unpack("<I", header_pickle[4:8])[0]
    return hashlib.sha256(header_pickle[8 : 8 + header_length]).hexdigest()

def info_plist_path(asar: Path) -> Path | None:
    bundle = application_bundle(asar)
    return bundle / "Contents/Info.plist" if bundle is not None else None

def read_info_plist(asar: Path) -> dict[str, object] | None:
    plist = info_plist_path(asar)
    if plist is None:
        return None
    try:
        with plist.open("rb") as handle:
            info = plistlib.load(handle)
    except (OSError, plistlib.InvalidFileException):
        return None
    return info if isinstance(info, dict) else None

def asar_integrity_entry(asar: Path, info: dict[str, object] | None) -> dict | None:
    """The bundle's ElectronAsarIntegrity record for this ASAR, if it has one."""
    bundle = application_bundle(asar)
    if bundle is None or info is None:
        return None
    integrity = info.get("ElectronAsarIntegrity")
    if not isinstance(integrity, dict):
        return None
    entry = integrity.get(asar.relative_to(bundle / "Contents").as_posix())
    return entry if isinstance(entry, dict) else None

def sync_asar_integrity(asar: Path) -> bool:
    """Point the bundle's ElectronAsarIntegrity entry at the installed ASAR.

    Codex ships with Electron's EnableEmbeddedAsarIntegrityValidation fuse on,
    so an Info.plist hash that does not match the ASAR header aborts the app
    during startup. Returns whether the plist changed.
    """
    info = read_info_plist(asar)
    entry = asar_integrity_entry(asar, info)
    plist = info_plist_path(asar)
    if entry is None or plist is None:
        return False
    digest = asar_header_sha256(asar)
    if entry.get("algorithm") == "SHA256" and entry.get("hash") == digest:
        return False
    entry["algorithm"] = "SHA256"
    entry["hash"] = digest
    with plist.open("rb") as handle:
        binary = handle.read(6) == b"bplist"
    temporary_target = plist.parent / f".{plist.name}.codex-desktop-patch-{os.getpid()}.tmp"
    try:
        with temporary_target.open("wb") as handle:
            plistlib.dump(
                info,
                handle,
                fmt=plistlib.FMT_BINARY if binary else plistlib.FMT_XML,
                sort_keys=False,
            )
        shutil.copymode(plist, temporary_target)
        os.replace(temporary_target, plist)
    finally:
        if temporary_target.exists():
            temporary_target.unlink()
    return True

def running_application_pids(bundle: Path) -> list[int]:
    # Matches only the main executable; helper processes live under
    # Contents/Frameworks and quit with it.
    result = subprocess.run(
        ["/usr/bin/pgrep", "-f", str(bundle / "Contents/MacOS/")],
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        return []
    return [int(line) for line in result.stdout.split()]

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
    print(f"[codex-desktop-patch] built {LAUNCH_WATCHER}")


def restore_patched_asar(asar: Path) -> None:
    """Put back the pristine app.asar if an earlier release patched it in place.

    This is the only write into the application bundle left in the mod and
    therefore the only step that needs App Management.
    """
    node = find_node(asar)
    with tempfile.TemporaryDirectory(prefix="codex-desktop-restore-") as temp_dir_name:
        if not asar_is_patched(node, asar):
            return
        backup = find_original_backup(node, asar, Path(temp_dir_name))
        if backup is None:
            print(
                "[codex-desktop-patch] the installed app.asar was patched by an "
                "earlier release, but no pristine backup was found; reinstall "
                "Codex to restore it"
            )
            return
        restore_asar(asar, backup)
        sync_asar_integrity(asar)
        print(f"[codex-desktop-patch] restored original ASAR from {backup}")


def remove_legacy_files() -> None:
    for leftover in LEGACY_PATHS:
        try:
            leftover.unlink()
        except OSError:
            pass


def uninstall_mod(asar: Path, cache_dir: Path) -> int:
    """Stop the host, drop its cache and restore an app.asar patched in place."""
    manage_launch_agent.uninstall()

    try:
        restore_patched_asar(asar)
    except PermissionError:
        print(
            f"[codex-desktop-patch] cannot restore {asar}: grant App Management to "
            "the terminal application under System Settings > Privacy & Security, "
            "then run make uninstall again",
            file=sys.stderr,
        )
        return 1
    except (OSError, RuntimeError) as exc:
        print(f"[codex-desktop-patch] uninstall failed: {exc}", file=sys.stderr)
        return 1

    shutil.rmtree(cache_dir, ignore_errors=True)
    remove_legacy_files()
    for leftover in (STATE_PATH, CONFIG_PATH):
        try:
            leftover.unlink()
        except OSError:
            pass
    print("[codex-desktop-patch] uninstalled; Codex keeps running without the mod")
    return 0


def migrate_legacy_install(asar: Path, cache_dir: Path) -> int:
    """Move an install that patched the application in place over to the host.

    The launch agent of those releases re-executes the patcher with
    ``--if-changed`` after pulling a newer release, so this runs inside that
    agent with launchd's minimal environment. The restore comes first so the
    cache is built from the pristine archive; installing the host agent ends
    with launchd stopping the legacy agent, and with it this process.
    """
    try:
        restore_patched_asar(asar)
    except PermissionError:
        print(
            f"[codex-desktop-patch] cannot restore {asar}; run make uninstall and "
            "make install from a terminal with App Management",
            file=sys.stderr,
        )
    status = build_renderer_cache(asar, cache_dir)
    if status != 0:
        return status
    build_launch_watcher()
    remove_legacy_files()
    manage_launch_agent.install(manage_launch_agent.resolve_node(None))
    return 0


def update_status() -> dict[str, object]:
    """What the host needs to decide whether a newer release is available."""
    remote, reachable = remote_release()
    local = local_release()
    return {
        "local_release": local,
        "remote_release": remote,
        "remote_reachable": reachable,
        "update_available": reachable and newer_release(remote, local),
        "head": repository_head(),
        "describe": repository_describe(),
        "automatic_updates": automatic_updates_enabled(),
    }


def main() -> int:
    sys.stdout.reconfigure(line_buffering=True)
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--asar", default=str(default_asar()), help="Path to Codex app.asar"
    )
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
        print(f"[codex-desktop-patch] missing ASAR: {asar}", file=sys.stderr)
        return 1
    cache_dir = Path(args.renderer_cache).expanduser()

    if args.uninstall:
        return uninstall_mod(asar, cache_dir)

    try:
        if args.dry_run:
            with tempfile.TemporaryDirectory(prefix="codex-desktop-dry-run-") as temp_dir:
                build_renderer_cache(asar, Path(temp_dir))
            print("[codex-desktop-patch] dry run complete; no files changed")
            return 0
        if args.if_changed:
            return migrate_legacy_install(asar, cache_dir)
        status = build_renderer_cache(asar, cache_dir)
        if status == 0:
            build_launch_watcher()
        return status
    except (OSError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"[codex-desktop-patch] failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
