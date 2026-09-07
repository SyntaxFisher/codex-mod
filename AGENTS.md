# Agent instructions

## Releases and versioning

- Never release without the user's explicit approval. Committing is fine;
  creating or pushing a release tag requires their go-ahead first.
- A release is a semver Git tag on `main` without a `v` prefix, for example `1.0.0`.
- The host's five-minute update check only pulls and rebuilds when a release
  tag newer than the installed one appears on the remote. Commits pushed
  without a new tag are never installed automatically.
- Always tag actual releases. To release: commit on `main`, then

  ```sh
  git tag -a <version> -m "<one-line summary>"
  git push --follow-tags
  ```

- Never delete or move a published release tag.
- The host runs from the checkout the LaunchAgent points at, so `main` is
  what users run. The renderer cache's `manifest.json` records the release
  and `git describe` output it was built from, and the host logs them on
  startup. `make install` installs the current checkout.

## Architecture constraints

- Never modify the installed Codex application. macOS 26 refuses Apple
  Events from a sender whose code signature no longer validates, which
  breaks appshots and computer use; the mod therefore serves patched
  renderer bundles over the DevTools protocol instead. The only bundle write
  left is restoring an `app.asar` that an earlier release patched in place.
- The patcher reads `app.asar` through its header itself; the project has no
  npm dependencies and needs no `node_modules`.
- Every dialog the host shows goes through `showMessageBox`, which renders
  the in-page modal (`modalScript` in `scripts/profile_switcher.cjs`) in the
  main Codex window, the same modal every confirmation and error uses. Never
  add a native prompt: AppleScript's `display dialog` is only the stand-in
  while no Codex window is attached, and `NSAlert` driven through JXA does
  not appear on macOS 26.
- Keep the patcher's hidden `--if-changed` flag. The `dev.codex-mod.watch`
  agent of releases before 2.0.0 re-executes the patcher with it after
  pulling a release; that call is what migrates those installs to the host.
- The host agent runs on the Node.js inside the Codex bundle, so installs
  need no user-installed Node.js and launchd never has to run a version
  manager's shim.
