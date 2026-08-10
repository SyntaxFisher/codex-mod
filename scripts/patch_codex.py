#!/usr/bin/env python3
"""Patch Codex Desktop's model picker and add a provider profile switcher."""

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

import manage_launch_agent


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
CODEX_HOME = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
PROFILE_SWITCHER_SOURCE = SCRIPT_DIR / "profile_switcher.cjs"
ASAR_CLI = REPO_ROOT / "node_modules/@electron/asar/bin/asar.mjs"
ASAR_PACKER = SCRIPT_DIR / "pack_preserving_unpacked.mjs"
BACKUP_DIR = CODEX_HOME / "backups/codex-app-asar"


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
UNPATCHED_MODEL_FILTER_RE = re.compile(
    rf"if\(({IDENT})\?({IDENT})\.has\(({IDENT})\.model\):!\3\.hidden\)\{{"
)
PATCHED_MODEL_FILTER_RE = re.compile(
    rf"if\(!({IDENT})\.hidden(?:\|({IDENT})\*({IDENT})\.has\(\1\.model\)"
    rf"|\|\|({IDENT})&&({IDENT})\.has\(\1\.model\))\)\{{"
)
UPSTREAM_MODEL_FILTER_RE = re.compile(
    rf"return ({IDENT})\?\.has\(({IDENT})\.model\)===!0\|\|\("
    rf"({IDENT})&&({IDENT})!==`amazonBedrock`\?({IDENT})\.has\(\2\.model\):!\2\.hidden\)"
)
PATCHED_UPSTREAM_MODEL_FILTER_RE = re.compile(
    rf"return ({IDENT})\?\.has\(({IDENT})\.model\)===!0\|\|!\2\.hidden\|\|\("
    rf"({IDENT})&&({IDENT})!==`amazonBedrock`&&({IDENT})\.has\(\2\.model\)\)"
)
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


def repository_head() -> str | None:
    result = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"],
        text=True,
        capture_output=True,
    )
    return result.stdout.strip() if result.returncode == 0 else None


def pull_patch_sources() -> bool:
    """Fast-forward the repository and report whether HEAD moved."""
    head_before = repository_head()
    if head_before is None:
        return False
    try:
        result = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "pull", "--ff-only", "--quiet"],
            text=True,
            capture_output=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        print("[codex-desktop-patch] git pull timed out; patching with local sources")
        return False
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        print(
            f"[codex-desktop-patch] git pull failed ({detail}); "
            "patching with local sources"
        )
        return False
    return repository_head() != head_before


def refresh_launch_agent(asar: Path) -> None:
    """Reinstall the launch agent when its installed plist is out of date."""
    installed = manage_launch_agent.installed_configuration()
    if installed is None or installed == manage_launch_agent.agent_configuration(asar):
        return
    print("[codex-desktop-patch] launch agent configuration changed; reinstalling")
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


def run_asar(node: Path, *args: str | Path) -> None:
    if not ASAR_CLI.is_file():
        raise RuntimeError(
            f"missing ASAR dependency: {ASAR_CLI}\nRun make setup in {REPO_ROOT} first."
        )
    result = subprocess.run(
        [str(node), str(ASAR_CLI), *(str(arg) for arg in args)],
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(f"ASAR command failed: {detail}")


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


def likely_model_filter_context(
    text: str, start: int, end: int, total_matches: int
) -> bool:
    if total_matches == 1:
        return True
    window = text[max(0, start - 1000) : min(len(text), end + 1000)]
    return "supportedReasoningEfforts" in window and "isDefault" in window


def patch_model_picker(renderer_path: Path) -> tuple[int, bool]:
    text = renderer_path.read_text(encoding="utf-8")
    matches = list(UNPATCHED_MODEL_FILTER_RE.finditer(text))
    targets = [
        match
        for match in matches
        if likely_model_filter_context(text, match.start(), match.end(), len(matches))
    ]

    if not targets:
        upstream_matches = list(UPSTREAM_MODEL_FILTER_RE.finditer(text))
        if upstream_matches:
            for match in reversed(upstream_matches):
                available_models, model, use_hidden_models, auth_method, allowlist = (
                    match.groups()
                )
                replacement = (
                    f"return {available_models}?.has({model}.model)===!0||!{model}.hidden||("
                    f"{use_hidden_models}&&{auth_method}!==`amazonBedrock`&&"
                    f"{allowlist}.has({model}.model))"
                )
                text = text[: match.start()] + replacement + text[match.end() :]
            renderer_path.write_text(text, encoding="utf-8")
            return len(upstream_matches), True
        return 0, (
            PATCHED_MODEL_FILTER_RE.search(text) is not None
            or PATCHED_UPSTREAM_MODEL_FILTER_RE.search(text) is not None
        )

    pieces: list[str] = []
    cursor = 0
    for match in targets:
        show_hidden_var, allowlist_var, model_var = (
            match.group(1),
            match.group(2),
            match.group(3),
        )
        replacement = (
            f"if(!{model_var}.hidden|{show_hidden_var}*"
            f"{allowlist_var}.has({model_var}.model)){{"
        )
        pieces.append(text[cursor : match.start()])
        pieces.append(replacement)
        cursor = match.end()
    pieces.append(text[cursor:])
    renderer_path.write_text("".join(pieces), encoding="utf-8")
    return len(targets), True


def renderer_bundles(extracted_dir: Path) -> list[Path]:
    bundles = sorted((extracted_dir / "webview/assets").glob("*.js"))
    if not bundles:
        raise RuntimeError("no Codex renderer bundles were found")
    return bundles


def javascript_bundles(extracted_dir: Path) -> list[Path]:
    bundles = renderer_bundles(extracted_dir)
    bundles.extend(sorted((extracted_dir / ".vite/build").glob("*.js")))
    return bundles


def patch_model_picker_bundles(bundles: list[Path]) -> tuple[int, bool]:
    replacements = 0
    ready = False
    preferred = sorted(
        bundles,
        key=lambda path: (
            not path.name.startswith("app-initial-"),
            not path.name.startswith("model-list-filter-"),
            path.name,
        ),
    )
    for bundle in preferred:
        text = bundle.read_text(encoding="utf-8")
        if "supportedReasoningEfforts" not in text or ".hidden" not in text:
            continue
        bundle_replacements, bundle_ready = patch_model_picker(bundle)
        replacements += bundle_replacements
        ready = ready or bundle_ready
        if ready:
            break
    return replacements, ready


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


def inject_profile_switcher(extracted_dir: Path, node: Path) -> tuple[bool, Path]:
    package = json.loads((extracted_dir / "package.json").read_text(encoding="utf-8"))
    main_path = extracted_dir / package["main"]
    if not main_path.is_file():
        raise RuntimeError(f"main bundle is missing: {main_path}")

    module_path = main_path.parent / "codex-profile-switcher.cjs"
    source = PROFILE_SWITCHER_SOURCE.read_text(encoding="utf-8")
    subprocess.run([str(node), "--check", str(PROFILE_SWITCHER_SOURCE)], check=True)

    changed = (
        not module_path.exists() or module_path.read_text(encoding="utf-8") != source
    )
    if changed:
        module_path.write_text(source, encoding="utf-8")

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
    return changed, module_path


def backup_asar(asar: Path, original_hash: str) -> Path:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    backup = BACKUP_DIR / f"app.asar.{original_hash[:16]}.bak"
    if not backup.exists():
        shutil.copy2(asar, backup)
    return backup


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
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--asar", default=str(default_asar()), help="Path to Codex app.asar"
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-backup", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()

    # Markers are derived from the sources at import time, so a moved HEAD
    # requires re-executing the patcher with the freshly pulled sources.
    if (
        not args.dry_run
        and os.environ.get("CODEX_MOD_PULLED") != "1"
        and pull_patch_sources()
    ):
        print("[codex-desktop-patch] sources updated; restarting patcher")
        os.environ["CODEX_MOD_PULLED"] = "1"
        os.execv(sys.executable, [sys.executable, __file__, *sys.argv[1:]])

    asar = Path(args.asar).expanduser().resolve()
    if not asar.exists():
        print(f"[codex-desktop-patch] missing ASAR: {asar}")
        return 1
    if not PROFILE_SWITCHER_SOURCE.is_file():
        print(
            f"[codex-desktop-patch] missing profile switcher: {PROFILE_SWITCHER_SOURCE}",
            file=sys.stderr,
        )
        return 1
    if not args.dry_run:
        refresh_launch_agent(asar)

    node = find_node(asar)
    original_hash = sha256(asar)

    try:
        with tempfile.TemporaryDirectory(
            prefix="codex-desktop-patch-"
        ) as temp_dir_name:
            temp_dir = Path(temp_dir_name)
            extracted_dir = temp_dir / "app"
            packed_asar = temp_dir / "app.asar"
            run_asar(node, "extract", asar, extracted_dir)

            renderers = renderer_bundles(extracted_dir)
            model_replacements, model_filter_ready = patch_model_picker_bundles(
                renderers
            )
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
            profile_changed, _ = inject_profile_switcher(extracted_dir, node)
            changed = (
                model_replacements > 0
                or history_replacements > 0
                or bridge_changed
                or dispatch_removals > 0
                or resume_changed
                or resets_changed
                or profile_changed
            )

            print(f"[codex-desktop-patch] target: {asar}")
            print(
                "[codex-desktop-patch] model picker: "
                + (
                    f"{model_replacements} replacement(s)"
                    if model_replacements
                    else "ready"
                )
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
            if not model_filter_ready:
                raise RuntimeError("no known model-picker filter pattern was found")
            if not lists_all_providers:
                raise RuntimeError(
                    "provider-wide recent and archived thread listing was not detected"
                )
            if not resume_ready:
                raise RuntimeError(
                    "the active-provider resume override was not installed"
                )
            if not changed:
                print("[codex-desktop-patch] already patched")
                return 0
            if args.dry_run:
                print("[codex-desktop-patch] dry run complete; no files changed")
                return 0

            pack_asar(node, asar, extracted_dir, packed_asar)
            run_asar(node, "list", packed_asar)
            backup = None if args.no_backup else backup_asar(asar, original_hash)
            replace_asar(asar, packed_asar, original_hash)

            print(f"[codex-desktop-patch] patched: {asar}")
            if backup is not None:
                print(f"[codex-desktop-patch] backup: {backup}")
            print(
                "[codex-desktop-patch] restart Codex Desktop for changes to take effect"
            )
            return 0
    except (OSError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"[codex-desktop-patch] failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
