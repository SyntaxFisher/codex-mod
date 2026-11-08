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
- Python 3.10 or newer
- Xcode Command Line Tools, for compiling the launch watcher

The host runs on the Node.js that Codex ships, so no Node.js has to be installed.

No privacy permissions are needed. The host reads and writes only under `~/.codex` and talks to Codex over a DevTools socket bound to localhost.

## Install

```sh
make install
```

This compiles the launch watcher, builds the renderer cache from the installed Codex build, and installs the `dev.codex-mod.host` LaunchAgent that runs the host from this checkout at login. If Codex is already running without the mod, the host restarts it right away, running threads included; the same happens for a Codex that macOS reopens at login before the host is up. Dock launches are relaunched with the debugging switch automatically from then on.

To validate the patches against the installed Codex build without changing anything:

```sh
make dry-run
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

For a non-default installation, override `APP` or `ASAR`:

```sh
make install APP=/Applications/Codex.app
make dry-run ASAR=/path/to/app.asar
```

The host logs to `~/Library/Logs/codex-mod/host.log`.

To keep the desktop app's logins apart from the Codex CLI's, give the mod its own Codex home. The host then launches Codex with that `CODEX_HOME`, and the CLI keeps `~/.codex` to itself:

```sh
make install CODEX_HOME=~/.codex-desktop
```

Later `make` targets use the home the installed agent runs with. Never copy a login between the two homes: both sides refresh it, and each refresh invalidates the other side's copy. Sign in to each home separately instead.

To run the host on a different Node.js (22 or newer), pass it explicitly:

```sh
make install NODE=/path/to/node
```

### Upgrading from a release that patched the app in place

Releases before 2.0.0 rewrote `app.asar` and ran a `dev.codex-mod.watch` agent that pulled releases every five minutes. That agent picks up 2.0.0 on its own: after the pull it re-runs the patcher, which restores the pristine `app.asar` from the backup, builds the renderer cache, installs the host agent, and retires itself. The host then restarts the running Codex, because the old in-place patch stays loaded until it restarts. Nothing has to be run by hand. Running `make install` on such an install does the same from a terminal.

## Updates

Releases are semver Git tags such as `1.0.0`; commits pushed without a new tag are never installed automatically. Every five minutes the host asks the remote for its release tags. When a newer release exists, it fast-forwards the checkout, rebuilds the renderer cache, and restarts itself, which reloads Codex's windows with the new bundles. If Codex is running, a dialog inside the Codex window offers to reload the windows now; Codex itself keeps running and so do its threads, only an unsent composer draft is lost. Later postpones the reload until Codex quits. An unreachable remote is logged and retried on the next tick. The host also compares the checkout with the release it started from on every tick, so a release that reached the checkout without the host restarting, for example because the cache rebuild after the pull was interrupted by sleep, is applied on the next tick. The host logs the release it runs on startup. Each time Codex quits, the host restarts as well, so whatever went stale in a long-running host does not carry over into the next Codex session.

Automatic updates follow `~/.codex/.codex-mod-config.json`: `{"automaticUpdates": false}` turns them off, in which case updating means `git pull` followed by `make install`.

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

```sh
make uninstall
```

The Uninstall button in Settings > General does the same after an in-app confirmation, and restarts Codex without the mod afterwards; running threads stop. Either way this stops and removes the launch agent, removes the renderer cache and the mod's state files, and keeps the saved account logins and the checkout on disk. The terminal form leaves Codex running unmodified. Installs from releases that patched `app.asar` in place are restored from the pristine backup under `~/.codex/backups/codex-app-asar`; that single step writes into the application bundle and is the only one that needs the App Management permission for the terminal.

## Patch revisions

Public versions are semver Git tags; see [AGENTS.md](../AGENTS.md) for the release convention. The renderer cache records the release, the Git describe output and the patcher commit it was built from in its `manifest.json`, and the host logs them on startup. A cache built from a different patcher source, uncommitted edits included, or from another Codex build is rebuilt.
