#!/bin/sh
# Installs Codex Mod: downloads the newest release into
# ~/Library/Application Support/codex-mod and starts the launch agent that
# runs it at login. Running it again reinstalls; --uninstall removes the mod.
#
#   curl -fsSL https://github.com/SyntaxFisher/codex-mod/releases/latest/download/install.sh | sh
#   curl -fsSL https://github.com/SyntaxFisher/codex-mod/releases/latest/download/install.sh | sh -s -- --uninstall
#
# CODEX_HOME selects a separate Codex home; CODEX_MOD_VERSION installs a
# specific release instead of the newest.
set -eu

RELEASES_URL="${CODEX_MOD_RELEASES_URL:-https://github.com/SyntaxFisher/codex-mod/releases}"
INSTALL_ROOT="$HOME/Library/Application Support/codex-mod"

say() {
  printf 'codex-mod: %s\n' "$1"
}

fail() {
  printf 'codex-mod: %s\n' "$1" >&2
  exit 1
}

json_field() {
  /usr/bin/plutil -extract "$1" raw -o - "$2" 2>/dev/null || fail "the release description lacks $1"
}

# Unpacks the release into "$work/codex-mod-<version>" and prints the version.
download_release() {
  work=$1
  if [ -n "${CODEX_MOD_VERSION:-}" ]; then
    description_url="$RELEASES_URL/download/$CODEX_MOD_VERSION/release.json"
  else
    description_url="$RELEASES_URL/latest/download/release.json"
  fi
  /usr/bin/curl -fsSL "$description_url" -o "$work/release.json" ||
    fail "could not download $description_url"
  version=$(json_field version "$work/release.json")
  archive=$(json_field archive "$work/release.json")
  sha256=$(json_field sha256 "$work/release.json")
  case "$version" in
    *[!0-9.]* | "") fail "the release description names no valid version" ;;
  esac
  [ "$archive" = "codex-mod-$version.tar.gz" ] || fail "the release description names an unexpected archive"
  /usr/bin/curl -fsSL "$RELEASES_URL/download/$version/$archive" -o "$work/$archive" ||
    fail "could not download $archive"
  actual=$(/usr/bin/shasum -a 256 "$work/$archive" | cut -d ' ' -f 1)
  [ "$actual" = "$sha256" ] || fail "$archive does not match its published SHA-256"
  /usr/bin/tar -xzf "$work/$archive" -C "$work"
  [ "$(cat "$work/codex-mod-$version/VERSION")" = "$version" ] || fail "$archive does not hold release $version"
  printf '%s\n' "$version"
}

main() {
  [ "$(uname -s)" = Darwin ] || fail "Codex Mod runs on macOS only"
  node=""
  for app in /Applications/ChatGPT.app /Applications/Codex.app; do
    if [ -x "$app/Contents/Resources/cua_node/bin/node" ]; then
      node="$app/Contents/Resources/cua_node/bin/node"
      break
    fi
  done
  [ -n "$node" ] || fail "Codex Desktop was not found in /Applications; install it first"

  action=install
  case "${1:-}" in
    "") ;;
    --uninstall) action=uninstall ;;
    *) fail "unknown option $1" ;;
  esac

  if [ "$action" = uninstall ] && [ -f "$INSTALL_ROOT/current/scripts/codex_mod.mjs" ]; then
    exec "$node" "$INSTALL_ROOT/current/scripts/codex_mod.mjs" uninstall
  fi

  work=$(mktemp -d "${TMPDIR:-/tmp}/codex-mod.XXXXXX")
  trap 'rm -rf "$work"' EXIT
  version=$(download_release "$work")

  if [ "$action" = uninstall ]; then
    "$node" "$work/codex-mod-$version/scripts/codex_mod.mjs" uninstall
    return
  fi

  mkdir -p "$INSTALL_ROOT/releases"
  rm -rf "$INSTALL_ROOT/releases/$version"
  mv "$work/codex-mod-$version" "$INSTALL_ROOT/releases/$version"
  ln -sfn "releases/$version" "$INSTALL_ROOT/current"
  say "installing Codex Mod $version; a Codex running without the mod restarts and stops running chats"
  "$node" "$INSTALL_ROOT/current/scripts/codex_mod.mjs" install
  say "done. Open Codex as usual; the mod updates itself"
}

main "$@"
