# Agent instructions

## Releases and versioning

- Never release without the user's explicit approval. Committing is fine;
  creating or pushing a release tag requires their go-ahead first.
- A release is a semver Git tag on `main` without a `v` prefix, for example
  `1.0.0`, plus the GitHub release that `.github/workflows/release.yml`
  publishes for it: `codex-mod-<version>.tar.gz`, `release.json` and
  `install.sh`, built by `dev/build_release.mjs`.
- Installs look up `releases/latest/download/release.json` every five
  minutes and update when it names a newer version. Commits and tags without
  a published release are never installed automatically.
- To release, after the user's go-ahead:

  1. On a clean `main`, run `make test` and `make dry-run`, and
     `make release-archive VERSION=<version>` to check the archive builds.
  2. Tag and push. The tag message becomes the release notes: a one-line
     summary, optionally followed by details.

     ```sh
     git tag -a <version> -m "<one-line summary>"
     git push --follow-tags
     ```

  3. Wait for the workflow (`gh run watch` on its run), then check that
     `gh release view <version>` lists the three assets and that
     `curl -fsSL https://github.com/SyntaxFisher/codex-mod/releases/latest/download/release.json`
     names the new version.
  4. If the workflow fails, rerun it with `gh run rerun` when the cause was
     transient; otherwise fix it on `main` and release the next patch
     version.

- Never delete or move a published release tag or release.
- A release install runs from
  `~/Library/Application Support/codex-mod/current`. `make install`
  installs a development agent that runs the current checkout and never
  updates itself; the installer switches it back. The renderer cache's
  `manifest.json` records the release it was built from, and the host logs
  it on startup.

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
- Keep `scripts/patch_codex.py` and its flags. Checkout installs of
  releases before 5.0.0 run it with Python after pulling a release, to build
  the cache and to uninstall, and the `dev.codex-mod.watch` agent of
  releases before 2.0.0 runs it with `--if-changed`. It hands those calls to
  `scripts/codex_mod.mjs`; that call is what moves those installs into a
  release install. Everything else is Node.js: installs need neither Python
  nor the Xcode Command Line Tools nor Git.
- The host agent runs on the Node.js inside the Codex bundle, so installs
  need no user-installed Node.js and launchd never has to run a version
  manager's shim.

## Verification

- Every feature the mod injects has a check in `dev/verify.mjs`; add or
  update it together with the feature. The scenarios there only open menus
  and pages and never change a login or a setting.
- The repository is public. Reports, screenshots, videos and logs of the
  update checks stay outside it, and committed files and messages carry no
  names, e-mails, account ids, usage data, local paths or machine details.
  Run `python3 dev/privacy_check.py --message "<message>"` on the staged
  change before committing.
