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
# The CLI wrapper the host launches Codex with while browser tools use the
# ChatGPT login.
CLI_WRAPPER_DIR = CODEX_HOME / ".codex-mod-cli"

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

# Do not retry a failed match at every suffix of large embedded strings.
IDENT = r"(?<![A-Za-z0-9_$])[A-Za-z_$][A-Za-z0-9_$]*"
# A dotted reference such as `x.O1`, the shape module imports take.
MEMBER = rf"{IDENT}(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*"

# Codex renders from rspack chunks: ES modules under webview/assets whose
# `__webpack_modules__` object maps module ids to factories `(e,t,n){...}`,
# the third parameter being `__webpack_require__`. Modules shared by several
# entry points are duplicated across chunks, so every copy of a site is
# patched.
RENDERER_ROOT = "webview"
RENDERER_ASSETS = "webview/assets"
MODULE_HEADER_RE = re.compile(
    r'[{,]"?([A-Za-z0-9_$]+)"?\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{'
)

# `null` lists the threads of the active provider only, `[]` those of every
# provider.
ALL_PROVIDER_NULL_RE = re.compile(r"modelProviders:null")
RECENT_PROVIDER_WIDE_RE = re.compile(
    r'modelProviders:\[\],archived:!1,[^;]{0,200}?sendRequest\("thread/list",[^;]{0,120}'
    r'source:"recent_threads"'
)
ARCHIVED_PROVIDER_WIDE_RE = re.compile(
    r"listArchivedThreads\(\)\{return this\.listAllThreads\(\{modelProviders:\[\],"
    r"archived:!0\}\)\}"
)

# The app-server restart the root error boundary dispatches, at module scope
# of a module every window loads at startup. The bridges that need other
# modules are published next to it.
PROFILE_RESTART_DISPATCH_RE = re.compile(
    rf"function {IDENT}\(({IDENT})\)\{{({MEMBER})\.dispatchMessage\("
    r'"codex-app-server-restart",\{hostId:\1,intent:"restart",errorMessage:null\}\)\}'
)
REQUIRE_BRIDGE = "globalThis.__codexRequire??="

# The desktop host runs the app-server managers and hands each window an RPC
# client per execution host, kept in a scope atom keyed by host id. The
# window resets an entry to this shape when its connection drops.
APP_SERVER_CLIENT_SITE_RE = re.compile(
    rf"\.set\(({IDENT})\.({IDENT}),{IDENT},\{{status:{IDENT},client:null\}}\)"
)

# The usage-reset modal as the rate-limit banner opens it. The bridge opens it
# through the same opener and modal modules with the window's root scope.
USAGE_RESETS_MODAL_RE = re.compile(
    rf"\(0,({IDENT})\.({IDENT})\)\({IDENT},({IDENT})\.({IDENT}),\{{initialAvailableCount:"
    rf"{IDENT}\.rate_limit_reset_credits\?\.available_count\?\?0,isRateLimitReached:!0,"
)

# Both the usage fetch and the usage stream hand each parsed response to the
# rate-limit banner updater, so the bridge sits at the top of that function.
USAGE_SNAPSHOT_SITE_RE = re.compile(
    rf"(function {IDENT}\({IDENT},({IDENT})\)\{{)(?=let ({IDENT})=\2\.account_id\|\|\2\.user_id;"
    rf"if\(null==\3\)return;let {IDENT}=\2\.rate_limit_upsell)"
)

# The window's root scope, read by the error boundary that wraps every
# route. The usage resets bridge opens its modal through that scope.
ROOT_SCOPE_SITE_RE = re.compile(
    rf"(function {IDENT}\({IDENT}\)\{{let (?:{IDENT},)*{IDENT}=\(0,{IDENT}\.c\)\(\d+\),"
    rf"\{{children:{IDENT}\}}={IDENT},({IDENT})=)(\(0,{IDENT}\.{IDENT}\)\({IDENT}\.{IDENT}\))"
    rf"(?=,.{{0,600}}?\2\.get\({IDENT}\.{IDENT}\)\.forEach\({IDENT}\))"
)

# react-intl's provider render, the one place every translated label passes
# through. Publishing the live intl object lets the host resolve labels by
# message id instead of matching English text.
INTL_PROVIDER_SITE_RE = re.compile(
    r'(\{value:)this\.state\.intl(\}(?=.{0,200}displayName="IntlProvider"))',
    re.DOTALL,
)

# The buttons the host attaches to, tagged so the switcher finds them by the
# attribute rather than by their translated label. Each entry names the
# message id rendered by the button and a pattern for the JSX call to tag;
# `before` patterns take the last match ahead of the id, the others the
# first match after it.
ANCHOR_ATTRIBUTE = "data-codex-mod-anchor"
FOOTER_LABEL_RE = re.compile(
    rf'({IDENT})\?{IDENT}\.formatMessage\(\{{id:"codex\.profileFooter\.openProfileMenu"'
)
FOOTER_BUTTON_RE = re.compile(
    rf'\(0,{IDENT}\.jsxs?\)\((?:"button"|{IDENT}),\{{(?=[^{{}}]{{0,400}}"aria-label":{IDENT},)'
)
SIGN_IN_BUTTON_RE = re.compile(rf'\(0,{IDENT}\.jsxs\)\("button",\{{')
SIGN_IN_ALTERNATIVE_BUTTON_RE = re.compile(rf'\(0,{IDENT}\.jsx\)\("button",\{{')

# The message ids behind the buttons the host attaches to. Their labels are
# collected from every locale chunk Codex ships, so the switcher recognizes
# the buttons in any UI language even while a page runs the stock bundles.
ANCHOR_MESSAGE_IDS = (
    "codex.profileFooter.openProfileMenu",
    "electron.onboarding.login.chatgpt.continueToSignIn",
    "electron.onboarding.login.apikey.open.welcomeV2",
)
LOCALE_MARKER = f'"{ANCHOR_MESSAGE_IDS[0]}":"'
ANCHOR_LABELS_FILE = "anchor-labels.json"

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

    def tree(self, directory: str, suffix: str, relative_to: str) -> dict[str, bytes]:
        """The packed files below an archive directory, by path below ``relative_to``."""
        found: list[tuple[str, dict]] = []

        def walk(node: dict, prefix: str) -> None:
            for name, child in sorted(node.get("files", {}).items()):
                path = f"{prefix}/{name}"
                if "files" in child:
                    walk(child, path)
                elif name.endswith(suffix) and "offset" in child:
                    found.append((path, child))

        walk(self.entry(directory) or {}, directory)
        files = {}
        with self.path.open("rb") as handle:
            for path, child in sorted(found, key=lambda item: int(item[1]["offset"])):
                handle.seek(self.data_start + int(child["offset"]))
                files[path.removeprefix(f"{relative_to}/")] = handle.read(child["size"])
        return files

    def package_version(self) -> str | None:
        try:
            version = json.loads(self.read("package.json")).get("version")
        except (RuntimeError, OSError, ValueError):
            return None
        return version if isinstance(version, str) else None


class Bundle:
    """A renderer chunk held in memory while the patches run over it.

    ``name`` is its path below the renderer root, the path the window
    requests it by.
    """

    def __init__(self, name: str, text: str) -> None:
        self.name = name
        self.original = text
        self.text = text
        self._headers: list[tuple[int, str]] | None = None

    @property
    def changed(self) -> bool:
        return self.text != self.original

    @property
    def is_locale(self) -> bool:
        return LOCALE_MARKER in self.original

    def module_headers(self) -> list[tuple[int, str]]:
        """Start offset and ``__webpack_require__`` parameter of each module factory."""
        if self._headers is None:
            self._headers = [(m.start(), m.group(4)) for m in MODULE_HEADER_RE.finditer(self.text)]
        return self._headers

    def enclosing_modules(self, index: int) -> list[tuple[int, str]]:
        """Module headers before ``index``, nearest first."""
        headers = self.module_headers()
        return [header for header in reversed(headers) if header[0] < index][:3]

    def require_name(self, index: int) -> str | None:
        """The ``__webpack_require__`` parameter of the module enclosing ``index``."""
        for start, require in self.enclosing_modules(index):
            if f'{require}("' in self.text[start:index]:
                return require
        return None

    def import_id(self, index: int, variable: str) -> str | None:
        """The module id that ``variable`` imports in the module enclosing ``index``."""
        require = self.require_name(index)
        if require is None:
            return None
        start = next(start for start, name in self.enclosing_modules(index) if name == require
                     and f'{require}("' in self.text[start:index])
        match = re.search(
            rf'(?<![\w$]){re.escape(variable)}={re.escape(require)}\("([^"]+)"\)',
            self.text[start:index],
        )
        return None if match is None else match.group(1)

    def invalidate(self) -> None:
        self._headers = None


def code_bundles(bundles: list[Bundle], needle: str) -> list[Bundle]:
    """The non-locale chunks containing ``needle``."""
    return [bundle for bundle in bundles if needle in bundle.text and not bundle.is_locale]


def patch_provider_history(bundles: list[Bundle]) -> bool:
    """List recent and archived threads across providers; report whether both took."""
    recent_provider_wide = False
    archived_provider_wide = False
    for bundle in code_bundles(bundles, "modelProviders:"):
        bundle.text = ALL_PROVIDER_NULL_RE.sub("modelProviders:[]", bundle.text)
        recent_provider_wide |= RECENT_PROVIDER_WIDE_RE.search(bundle.text) is not None
        archived_provider_wide |= ARCHIVED_PROVIDER_WIDE_RE.search(bundle.text) is not None
    return recent_provider_wide and archived_provider_wide


def inject_profile_restart_bridge(bundles: list[Bundle]) -> bool:
    """Expose the app-server restart so a provider switch needs no relaunch.

    Publishes ``__webpack_require__`` alongside, from the same startup
    module, for the bridges that open modules by id.
    """
    for bundle in code_bundles(bundles, '"codex-app-server-restart"'):
        match = PROFILE_RESTART_DISPATCH_RE.search(bundle.text)
        if match is None:
            continue
        require = bundle.require_name(match.start())
        if require is None:
            continue
        bridge = match.group(2)
        injection = (
            f";{REQUIRE_BRIDGE}{require};"
            "globalThis.__codexProfileRestart=()=>{"
            f'{bridge}.dispatchMessage("codex-app-server-restart",'
            '{hostId:"local",intent:"restart"});return!0};'
        )
        bundle.text = bundle.text[: match.end()] + injection + bundle.text[match.end() :]
        bundle.invalidate()
        return True
    return False


def require_bridge_host(bundles: list[Bundle]) -> Bundle | None:
    """The chunk publishing ``__webpack_require__``, where module bridges go."""
    return next((bundle for bundle in bundles if REQUIRE_BRIDGE in bundle.text), None)


def add_module_bridge(host: Bundle, injection: str) -> None:
    """Insert ``injection`` right after the require publication."""
    marker = host.text.index(REQUIRE_BRIDGE)
    insert_at = host.text.index(";", marker) + 1
    host.text = host.text[:insert_at] + injection + host.text[insert_at:]
    host.invalidate()


def inject_app_server_client_bridge(bundles: list[Bundle]) -> bool:
    """Expose the window's app-server client per host so the mod can read and start threads.

    Runs after the restart bridge, whose module publishes the require
    function, and after the root scope capture.
    """
    host = require_bridge_host(bundles)
    if host is None:
        return False
    for bundle in code_bundles(bundles, "client:null}"):
        match = APP_SERVER_CLIENT_SITE_RE.search(bundle.text)
        if match is None:
            continue
        atom = bundle.import_id(match.start(), match.group(1))
        if atom is None:
            continue
        add_module_bridge(
            host,
            "globalThis.__codexAppServerClient=e=>{let t=globalThis.__codexScope,"
            "r=globalThis.__codexRequire;return t==null||r==null?null:"
            f"t.get(r({json.dumps(atom)}).{match.group(2)},e)?.client?.rpc??null}};",
        )
        return True
    return False


def inject_usage_resets_bridge(bundles: list[Bundle]) -> bool:
    """Expose the usage-reset modal opener so the sidebar pill can call it.

    Runs after the restart bridge, whose module publishes the require
    function this bridge opens the modules with, and after the root scope
    capture.
    """
    host = require_bridge_host(bundles)
    if host is None:
        return False
    for bundle in code_bundles(bundles, "rate_limit_reset_credits?.available_count"):
        match = USAGE_RESETS_MODAL_RE.search(bundle.text)
        if match is None:
            continue
        opener = bundle.import_id(match.start(), match.group(1))
        modal = bundle.import_id(match.start(), match.group(3))
        if opener is None or modal is None:
            continue
        injection = (
            "globalThis.__codexOpenUsageResets=e=>{let t=globalThis.__codexScope,"
            "r=globalThis.__codexRequire;if(t==null||r==null)return;"
            f"(0,r({json.dumps(opener)}).{match.group(2)})(t,r({json.dumps(modal)}).{match.group(4)},"
            "{defaultResetCreditsOpen:!0,initialAvailableCount:e??0,isRateLimitReached:!1})};"
        )
        add_module_bridge(host, injection)
        return True
    return False


def inject_rate_limit_status_bridge(bundles: list[Bundle]) -> bool:
    """Report each usage response the app receives for its own display."""
    injected = False
    for bundle in code_bundles(bundles, ".rate_limit_upsell"):
        text, count = USAGE_SNAPSHOT_SITE_RE.subn(
            r"\1globalThis.__codexReportRateLimits?.(\2);", bundle.text
        )
        if count:
            bundle.text = text
            bundle.invalidate()
            injected = True
    return injected


def capture_root_scope(bundles: list[Bundle]) -> bool:
    """Publish the window's root scope for the usage resets bridge."""
    captured = False
    for bundle in code_bundles(bundles, ".forEach("):
        text, count = ROOT_SCOPE_SITE_RE.subn(r"\1(globalThis.__codexScope=\3)", bundle.text)
        if count:
            bundle.text = text
            bundle.invalidate()
            captured = True
    return captured


def inject_intl_bridge(bundles: list[Bundle]) -> bool:
    """Publish the live react-intl object so labels resolve by message id."""
    injected = False
    for bundle in code_bundles(bundles, 'displayName="IntlProvider"'):
        text, count = INTL_PROVIDER_SITE_RE.subn(
            r"\1(globalThis.__codexIntl=this.state.intl)\2", bundle.text
        )
        if count:
            bundle.text = text
            bundle.invalidate()
            injected = True
    return injected


def tag_call(text: str, index: int, value: str) -> str:
    """Add the anchor attribute to the JSX props object opening at ``index``."""
    brace = text.index("{", index)
    return f'{text[: brace + 1]}"{ANCHOR_ATTRIBUTE}":{value},{text[brace + 1 :]}'


def tag_after(text: str, start: int, pattern: re.Pattern, value: str, window: int) -> str | None:
    match = pattern.search(text, start, start + window)
    return None if match is None else tag_call(text, match.start(), value)


def tag_before(text: str, end: int, pattern: re.Pattern, value: str, window: int) -> str | None:
    matches = list(pattern.finditer(text, max(0, end - window), end))
    return None if not matches else tag_call(text, matches[-1].start(), value)


def tag_anchor_sites(bundles: list[Bundle]) -> list[str]:
    """Tag the buttons the host attaches to; return the anchors that were not found."""
    found: set[str] = set()

    def apply(name: str, tagged: str | None, bundle: Bundle) -> None:
        if tagged is not None:
            bundle.text = tagged
            bundle.invalidate()
            found.add(name)

    for bundle in bundles:
        if bundle.is_locale:
            continue
        text = bundle.text
        footer_id = text.find('id:"codex.profileFooter.openProfileMenu"')
        footer = (FOOTER_LABEL_RE.search(text, max(0, footer_id - 300), footer_id + 80)
                  if footer_id >= 0 else None)
        if footer is not None:
            condition = footer.group(1)
            apply(
                "profile-menu",
                tag_after(
                    text, footer.end(), FOOTER_BUTTON_RE,
                    f'{condition}?"profile-menu":"settings"', 6000,
                ),
                bundle,
            )
            text = bundle.text
        sign_in = text.find('id:"electron.onboarding.login.chatgpt.continueToSignIn"')
        if sign_in >= 0:
            apply("sign-in", tag_before(text, sign_in, SIGN_IN_BUTTON_RE, '"sign-in"', 800), bundle)
            text = bundle.text
        alternative = text.find('id:"electron.onboarding.login.apikey.open.explicit.welcomeV2"')
        if alternative >= 0:
            apply(
                "sign-in-alternative",
                tag_before(
                    text, alternative, SIGN_IN_ALTERNATIVE_BUTTON_RE, '"sign-in-alternative"', 800
                ),
                bundle,
            )
    return [name for name in ("profile-menu", "sign-in", "sign-in-alternative") if name not in found]


def extract_anchor_labels(files: dict[str, bytes]) -> dict[str, list[str]]:
    """The translated labels of every anchor, across the locale chunks."""
    labels = {message_id: [] for message_id in ANCHOR_MESSAGE_IDS}
    marker = LOCALE_MARKER.encode()
    for data in files.values():
        if marker not in data:
            continue
        text = data.decode("utf-8")
        for message_id, found in labels.items():
            match = re.search(rf'"{re.escape(message_id)}":("(?:[^"\\]|\\.)*")', text)
            if match is None:
                continue
            label = json.loads(match.group(1))
            if label not in found:
                found.append(label)
    return labels


def write_anchor_labels(archive: Asar, files: dict[str, bytes], cache_dir: Path) -> None:
    labels = extract_anchor_labels(files)
    if not any(labels.values()):
        log("no locale chunks found; the switcher matches the English labels only")
        return
    cache_dir.mkdir(parents=True, exist_ok=True)
    (cache_dir / ANCHOR_LABELS_FILE).write_text(
        json.dumps({"asar_header_sha256": archive.header_sha256, "labels": labels}, indent=2)
        + "\n",
        encoding="utf-8",
    )


def patcher_sha256() -> str:
    """Identifies the patches a cache was built with, uncommitted edits included."""
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def check_javascript(node: Path, bundle: Path) -> None:
    # The chunks are ES modules; Node only parses a file as one by extension.
    module = bundle.with_name(f"{bundle.name}.check.mjs")
    shutil.copyfile(bundle, module)
    try:
        result = subprocess.run([str(node), "--check", str(module)], text=True, capture_output=True)
    finally:
        module.unlink()
    if result.returncode != 0:
        # Node echoes the offending source line, which for a minified bundle
        # is the whole file; keep the location and the error itself.
        lines = [line for line in (result.stderr or result.stdout).splitlines() if line.strip()]
        location = lines[0].removeprefix(f"{module}:") if lines else ""
        error = next((line for line in reversed(lines) if "Error" in line), "")
        raise RuntimeError(
            f"JavaScript syntax check failed for {bundle.name} at line {location}: {error}"
        )


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
        and manifest.get("patcher_sha256") == patcher_sha256()
        and all((cache_dir / name).is_file() for name in manifest.get("files", []))
        and (cache_dir / ANCHOR_LABELS_FILE).is_file()
    ):
        log(f"renderer cache is current: {cache_dir}")
        return

    files = archive.tree(RENDERER_ASSETS, ".js", RENDERER_ROOT)
    if not files:
        raise RuntimeError("no Codex renderer chunks were found")
    # Written before the patches so the labels are there for a Codex build
    # the patches do not match, when the host serves the stock bundles.
    write_anchor_labels(archive, files, cache_dir)
    locale_marker = LOCALE_MARKER.encode()
    bundles = [
        Bundle(name, data.decode("utf-8"))
        for name, data in files.items()
        if locale_marker not in data
    ]
    del files
    if not patch_provider_history(bundles):
        raise RuntimeError("provider-wide recent and archived thread listing was not detected")
    # The host relaunches Codex and hides the resets pill when these bridges
    # are missing, so a changed Codex build degrades instead of failing.
    if not inject_profile_restart_bridge(bundles):
        log("profile restart bridge not found; provider switches relaunch Codex")
    if not inject_rate_limit_status_bridge(bundles):
        log("rate limit status bridge not found; usage refreshes from the poll only")
    # The module bridges open their modules through the require function the
    # restart bridge publishes, with the root scope captured here.
    if not capture_root_scope(bundles):
        log("root scope not found; the resets pill stays hidden and chats are not locked")
    if not inject_app_server_client_bridge(bundles):
        log("app-server client bridge not found; chats of other profiles are not locked")
    if not inject_usage_resets_bridge(bundles):
        log("usage resets bridge not found; the resets pill stays hidden")
    # Without the tags the switcher matches labels resolved through the intl
    # bridge, and without that bridge it falls back to the English labels.
    for name in tag_anchor_sites(bundles):
        log(f"anchor {name} not found; the switcher matches its label instead")
    if not inject_intl_bridge(bundles):
        log("intl bridge not found; labels only match in English")
    changed = [bundle for bundle in bundles if bundle.changed]
    # The host reloads a page that runs the stock bundles when it attaches;
    # the marker tells it which pages already run the patched ones.
    for bundle in changed:
        bundle.text += "\n;globalThis.__codexModBundles=!0;\n"

    # The patched bundles are staged and syntax-checked before they replace
    # the cache, so a failed check leaves the previous cache in place.
    node = manage_launch_agent.resolve_node(None)
    with tempfile.TemporaryDirectory(prefix="codex-desktop-renderer-") as temp_dir_name:
        staging = Path(temp_dir_name)
        for bundle in changed:
            staged = staging / bundle.name
            staged.parent.mkdir(parents=True, exist_ok=True)
            staged.write_text(bundle.text, encoding="utf-8")
            check_javascript(node, staged)
        cache_dir.mkdir(parents=True, exist_ok=True)
        for stale in cache_dir.glob("*.js"):
            stale.unlink()
        shutil.rmtree(cache_dir / "assets", ignore_errors=True)
        for bundle in changed:
            target = cache_dir / bundle.name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(staging / bundle.name, target)
    manifest = {
        "asar": str(asar),
        "asar_header_sha256": archive.header_sha256,
        "patcher_head": repository_head(),
        "patcher_sha256": patcher_sha256(),
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
    remove_files(*LEGACY_PATHS, CONFIG_PATH, CLI_WRAPPER_DIR)
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
    parser.add_argument(
        "--local-release",
        action="store_true",
        help="Print the newest release tag reachable from HEAD as JSON",
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
        print(
            json.dumps(
                {
                    "moved": moved,
                    "error": error,
                    "release": local_release(),
                    "describe": repository_describe(),
                }
            )
        )
        return 0 if error is None else 1
    if args.local_release:
        print(json.dumps({"release": local_release()}))
        return 0

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
