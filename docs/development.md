# Developing and maintaining Codex Mod

[Back to the product overview](../README.md)

## How it works

The installed application is never modified. A small host process runs in the background and:

- launches Codex with Chromium's `--remote-debugging-port` switch and swaps a Dock launch that lacks the switch for one that has it, within the first few hundred milliseconds, before a window appears;
- attaches to Codex over the DevTools protocol and answers the requests for the renderer chunks with patched copies from a cache under `~/.codex/.codex-mod-renderer-cache`;
- injects the sidebar controls into every window, and performs the account and provider switching that the controls request.

Codex occasionally drops the host's session to a window while the connection itself stays open, for example across a lid-close sleep. The host checks its attachments every thirty seconds and after every detach, re-attaches to such a window without reloading it, and logs the event.

Codex can also drop the whole DevTools connection without the host ever hearing about it: a helper Codex spawns inherits the socket, so the connection stays established after the browser stopped reading it, every command goes unanswered, and the usage display and the switcher freeze. The same thirty-second check serves as a heartbeat: when it times out twice while a fresh HTTP request to the debugging port still answers, the host ends the dead connection, connects again, and re-attaches to the windows without reloading them, since they still run the patched bundles. A window is only re-attached this way when it runs the build the host serves: each window is stamped with the injected sources and the renderer cache it was rendered from, and a window with another stamp, such as one an earlier release rendered into before the host restarted for an update, is reloaded instead.

Because the bundle and its code signature stay untouched, macOS features that check the signature of the sender, such as appshots and computer use, keep working. Earlier releases patched `app.asar` in place, which macOS 26 rejects for those features.

The patcher validates known bundle patterns and refuses to continue when they no longer match; the host then serves the stock bundles until a new release matches again.

Codex renders from rspack chunks under `webview/assets`, ES modules whose module factories receive `__webpack_require__`. Modules shared by several entry points are duplicated across chunks, so every copy of a patch site is patched. Most bridges are rewritten in place; those that need another module's exports, such as the usage-reset modal and the app-server client the chat lock reads threads through, open those modules by id through the require function a startup module publishes, with the window's root scope the error boundary captures. The cache keeps each patched chunk under its path below `webview`, the path the window requests it by.

The controls attach to Codex's own buttons independent of the UI language. The patcher tags the buttons in the bundles and, before patching anything, collects the buttons' labels in every language Codex ships into `anchor-labels.json` next to the cache. Where a tag is missing, for example while a page runs the stock bundles because the patches do not match a new Codex build, the switcher matches the buttons by those labels, by the label Codex's live translation object resolves for the message id, and by the English label.

## Requirements

- macOS
- Codex Desktop installed as `/Applications/ChatGPT.app` or `/Applications/Codex.app`

The host and all tooling run on the Node.js that Codex ships, so no Node.js has to be installed. Releases carry a prebuilt launch watcher; building one from a checkout needs the Xcode Command Line Tools, and the Codex release checks under `dev/` need Python 3.

No privacy permissions are needed. The host reads and writes only under `~/.codex`, its release install, and its logs, and talks to Codex over a DevTools socket bound to localhost.

## Install

The installer in the README downloads the newest release from GitHub:

```sh
curl -fsSL https://github.com/SyntaxFisher/codex-mod/releases/latest/download/install.sh | sh
```

It reads the release's `release.json`, downloads the archive it names, checks the archive's SHA-256, and unpacks it into `~/Library/Application Support/codex-mod/releases/<version>` with a `current` link pointing at it. It then runs the release's `scripts/codex_mod.mjs install` with the Node.js inside Codex, which builds the renderer cache from the installed Codex build and installs the `dev.codex-mod.host` LaunchAgent that runs the host through the `current` link at login. If Codex is already running without the mod, the host restarts it right away, running threads included; the same happens for a Codex that macOS reopens at login before the host is up. Dock launches are relaunched with the debugging switch automatically from then on.

`CODEX_MOD_VERSION=4.3.4` before `sh` installs that release instead of the newest. The host logs to `~/Library/Logs/codex-mod/host.log`.

To keep the desktop app's logins apart from the Codex CLI's, give the mod its own Codex home. The host then launches Codex with that `CODEX_HOME`, and the CLI keeps `~/.codex` to itself:

```sh
curl -fsSL https://github.com/SyntaxFisher/codex-mod/releases/latest/download/install.sh | CODEX_HOME=~/.codex-desktop sh
```

Reinstalls, updates and later commands keep the home the installed agent runs with. Never copy a login between the two homes: both sides refresh it, and each refresh invalidates the other side's copy. Sign in to each home separately instead.

### Development checkout

A clone of this repository installs a development agent that runs the host from the checkout:

```sh
make install
```

This compiles the launch watcher, builds the renderer cache, and installs the same `dev.codex-mod.host` agent with `CODEX_MOD_DEVELOPMENT=1` in its environment. A development install never updates itself; pull and run `make install` again instead. Running the installer switches the agent back to a release install.

To validate the patches against the installed Codex build without changing anything, and to run the tests:

```sh
make dry-run
make test
```

To compare with stock Codex, turn the mod off and on again without uninstalling it:

```sh
make off
make on
make status
```

`make off` disables the launch agent, also for the next login, and restarts a running Codex without the mod, which stops running chats. `make on` lets the host relaunch Codex with the mod. Saved account logins and the renderer cache stay in place.

For development, stop the agent and run the host in the foreground instead:

```sh
launchctl bootout gui/$(id -u)/dev.codex-mod.host
make host
```

For a non-default installation, override `APP` or `ASAR`, or run the host on a different Node.js (22 or newer):

```sh
make install APP=/Applications/Codex.app
make dry-run ASAR=/path/to/app.asar
make install NODE=/path/to/node
```

`make install CODEX_HOME=~/.codex-desktop` gives a development install its own Codex home; later `make` targets use the home the installed agent runs with.

### Upgrading from a checkout install

Releases before 5.0.0 were installed by cloning the repository and ran the host from the checkout, updating it with `git pull`. Those installs move to the release install on their own. Their host pulls 5.0.0 like any release and runs `scripts/patch_codex.py` from it, which now hands the cache build to the Node.js tooling. After the reload, the host starts from the checkout, finds no development marker in its environment, downloads the newest release into the release install, points the agent at it, and reloads the agent. The release's host serves the same bundles, so the windows are not reloaded a second time. The agent keeps its Codex home. When the download fails, the host keeps running from the checkout and tries again every five minutes. Once the release's host runs, it deletes the checkout, unless the checkout holds work of its own: uncommitted changes or untracked files, commits on any branch that no remote has, stashes, or other worktrees. Then the host keeps it and logs why. Running the installer over a checkout install moves it the same way.

### Upgrading from a release that patched the app in place

Releases before 2.0.0 rewrote `app.asar` and ran a `dev.codex-mod.watch` agent that pulled releases every five minutes. That agent picks up the newest release on its own: after the pull it re-runs `scripts/patch_codex.py --if-changed`, which restores the pristine `app.asar` from the backup, builds the renderer cache, installs the host agent for the checkout, and retires itself. That host then moves into the release install as above, and restarts the running Codex, because the old in-place patch stays loaded until it restarts. Nothing has to be run by hand.

## Updates

Releases are semver Git tags such as `1.0.0`. The release workflow builds and publishes the GitHub release for each tag; installs only see a release once that release exists, so commits and tags without a published release are never installed automatically. Every five minutes the host downloads the newest release's `release.json`. When it names a newer version, the host downloads and checks the archive, unpacks it next to the running release, moves the `current` link, rebuilds the renderer cache with the new release's patcher, and restarts itself, which reloads Codex's windows with the new bundles. If Codex is running, a dialog inside the Codex window offers to reload the windows now; Codex itself keeps running and so do its threads, only an unsent composer draft is lost. Later postpones the reload until Codex quits. An unreachable release server is logged and retried on the next tick. The host also compares the linked release with the release it started from on every tick, so a release that was unpacked without the host restarting, for example because the cache rebuild was interrupted by sleep, is applied on the next tick. On startup the host logs the release it runs and removes unpacked releases other than the running and the linked one. Each time Codex quits, the host restarts as well, so whatever went stale in a long-running host does not carry over into the next Codex session.

Automatic updates follow `~/.codex/.codex-mod-config.json`: `{"automaticUpdates": false}` turns them off, in which case running the installer again updates.

## Codex updates

Codex replaces `app.asar` when it updates itself. The host notices that the cache no longer matches the installed build the next time Codex launches, rebuilds it, and reloads the windows once the rebuild finishes. Until then Codex runs stock; if the patterns no longer match the new build, the host keeps serving stock bundles and logs the failure.

### Checking a Codex release

`dev/` holds the tooling that tests the mod against new Codex releases on a maintainer's machine:

- `python3 dev/codex_update.py check` compares the appcast with the installed build and archives the installed build as an APFS clone, so later releases can be compared with it. `install-agent` runs the check every hour; with `--trigger` a pending release or an unverified build starts the agent task stored next to the state.
- `python3 dev/codex_update.py install` downloads the newest release, verifies its signature and team, and replaces the installed app.
- `python3 dev/codex_update.py verify` runs the patcher's dry run, compares Codex's own messages in the areas the mod touches with the previous build, and drives the app through `dev/verify.mjs` once with the mod and once stock. The report names a verdict (green, yellow or red) with its reasons and comes with a full-resolution screenshot of every step and a recording of each run.
- `node dev/record.mjs --port 48123 --out demo.mp4` records the Codex window at full resolution until it is stopped, for demonstrating a specific behaviour while something else drives the app.

State, reports and media stay in `~/Library/Application Support/codex-mod-dev`, never in the repository. `python3 dev/privacy_check.py` checks a staged change for e-mails, local paths, user and host names, private addresses and the identities of the logins on the machine.

## Uninstall

The Uninstall button in Settings > General removes the mod after an in-app confirmation and restarts Codex without the mod afterwards; running threads stop. From a terminal:

```sh
curl -fsSL https://github.com/SyntaxFisher/codex-mod/releases/latest/download/install.sh | sh -s -- --uninstall
```

or `make uninstall` in a checkout. Either way this stops and removes the launch agent, removes the renderer cache, the mod's state files and the release install, and keeps the saved account logins and a development checkout on disk. The terminal forms leave Codex running unmodified. Installs from releases that patched `app.asar` in place are restored from the pristine backup under `~/.codex/backups/codex-app-asar`; that single step writes into the application bundle and is the only one that needs the App Management permission for the terminal.

## Patch revisions

Public versions are semver Git tags; see [AGENTS.md](../AGENTS.md) for the release convention. The renderer cache records the release it was built from in its `manifest.json`, for a checkout also the Git describe output and commit, and the host logs them on startup. A cache built from a different patcher source, uncommitted edits included, or from another Codex build is rebuilt; a release that leaves the patcher unchanged reuses the bundles and only updates the release the manifest names.
