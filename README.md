# codex-mod

An unofficial macOS companion for Codex Desktop that switches between the built-in OpenAI provider and custom providers configured in `~/.codex/config.toml`.

The mod adds an icon-only provider menu beside the profile footer, switches between captured ChatGPT accounts from the same menu, makes recent and archived chats visible across providers, and continues every chat under the active provider, even when the chat was started under a different one.

## How it works

The installed application is never modified. A small host process runs in the background and:

- launches Codex with Chromium's `--remote-debugging-port` switch and swaps a Dock launch that lacks the switch for one that has it, within the first few hundred milliseconds, before a window appears;
- attaches to Codex over the DevTools protocol and answers the requests for the renderer bundles with patched copies from a cache under `~/.codex/.codex-mod-renderer-cache`;
- injects the sidebar controls into every window, and performs the account and provider switching that the controls request.

Because the bundle and its code signature stay untouched, macOS features that check the signature of the sender, such as appshots and computer use, keep working. Earlier releases patched `app.asar` in place, which macOS 26 rejects for those features.

The patcher validates known bundle patterns and refuses to continue when they no longer match; the host then serves the stock bundles until a new release matches again.

## Requirements

- macOS
- Codex Desktop installed as `/Applications/ChatGPT.app` or `/Applications/Codex.app`
- Python 3.10 or newer
- npm for installing `@electron/asar`; the host itself runs on the Node.js that Codex ships, so no other Node.js is needed
- Xcode Command Line Tools, for compiling the launch watcher

No privacy permissions are needed. The host reads and writes only under `~/.codex` and talks to Codex over a DevTools socket bound to localhost.

## Configure providers

The built-in `openai` provider is always available. Every top-level `[model_providers.<id>]` section becomes another menu option under the Profiles heading, using its configured `name`.

For example:

```toml
model = "gpt-5.4"
model_provider = "proxy"

[model_providers.proxy]
name = "Custom Proxy"
base_url = "https://proxy.example.com/v1"
env_key = "PROXY_API_KEY"
wire_api = "responses"
```

Provider credentials and endpoints remain in the normal Codex configuration. This repository does not manage them.

## Switch ChatGPT accounts

The menu presents an Accounts section above the Profiles section with the custom providers. Each account entry stands for the built-in OpenAI provider under that ChatGPT login, so the Accounts section stays empty while no account is captured yet, and an account row is marked active only while the OpenAI provider is selected; the active entry is shown as a filled row. Selecting an account activates the OpenAI provider, injects the stored login into `~/.codex/auth.json`, restarts the local Codex host, and reloads the windows in one step. Entries are labelled with the account's name and plan from the login's identity token, falling back to the email address. The plus button on the Accounts heading starts the add-account flow, and hovering an account row reveals an X that forgets the stored login after confirmation; forgetting the signed-in account also signs Codex out, since it would otherwise be captured again right away.

Accounts are captured automatically. Every ten seconds the host compares the live `auth.json` with its account store in `~/.codex/.codex-mod-accounts/`; an unknown ChatGPT login is snapshotted as a new account, and the active account's snapshot is refreshed whenever Codex rotates its tokens. The add-account flow backs up the current login and takes Codex to the sign-in screen, stopping running threads; the account logged in there is captured automatically. Logging out and back in through the normal Codex UI works just as well. API-key logins are not captured, and the add-account flow refuses to discard an API-key login since it could not be restored.

The signed-out screen has no sidebar, so it gets a Saved accounts pill below the stock sign-in buttons that expands into the saved accounts and profiles; selecting one signs in or switches exactly like the sidebar menu.

The refresh write-back matters because OpenAI refresh tokens are single-use: a snapshot that misses a rotation becomes permanently invalid. If a stored account stops working, for example after using the same login on another machine, log in with it once more to re-capture it. Before the first switch the previous `auth.json` is preserved once as `auth.json.bak.before-profile-switcher`.

## Usage status

The mod shows a status box above the sidebar footer. Its contents depend on the active provider.

### Custom providers

For a custom provider the box shows the key's spend, budget limit, and reset countdown. The data comes from the provider's LiteLLM-style `/key/info` endpoint, derived from `base_url` without the `/v1` suffix, authorized with the key from the provider's `env_key` environment variable.

The host resolves that variable the way Codex does: it reads the login shell's environment at startup, so a key exported in `~/.zshrc` or `~/.zprofile` is found even though launch agents start with a minimal environment. The box only appears when the variable is set there and the endpoint returns a valid budget.

### OpenAI

For the built-in `openai` provider the box shows the ChatGPT plan's rate limit windows, one bar per active window, labelled by window length with a reset countdown.

OpenAI currently exposes a single weekly window. A shorter window, such as the 5-hourly one, appears as a second bar automatically whenever the account reports it. Windows are ordered shortest first, independent of the slot the backend reports them in, so the row order stays stable and the window worth acting on stays on top.

When the account holds unused rate limit resets, a green pill next to the longest window's label reports how many are available and opens Codex's own usage reset dialog. Resets clear the account rather than a single window, so the pill deliberately avoids the short window's row. The pill is hidden when no resets are available, and also when the renderer bridge that opens the dialog is missing, so it is never a dead button. On a narrow sidebar the reset countdown is dropped before the pill.

The data comes from the bundled Codex binary's `account/rateLimits/read` app-server method, which is the same source the Desktop app uses for the usage summary in its profile menu. It requires a ChatGPT login; an API-key login reports no rate limits and the box stays hidden. Because each read starts a short-lived app server, this provider is polled once a minute rather than on the ten-second budget interval.

## Install

```sh
make install
```

This installs the npm dependency, compiles the launch watcher, builds the renderer cache from the installed Codex build, and installs the `dev.codex-mod.host` LaunchAgent that runs the host from this checkout at login. If Codex is already running, the host offers to restart it; declining leaves the mod to activate on the next launch. Dock launches are relaunched with the debugging switch automatically from then on.

To validate the patches against the installed Codex build without changing anything:

```sh
make dry-run
```

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

To run the host on a different Node.js (22 or newer), pass it explicitly:

```sh
make install NODE=/path/to/node
```

### Upgrading from a release that patched the app in place

Releases before 2.0.0 rewrote `app.asar` and ran a `dev.codex-mod.watch` agent that pulled releases every five minutes. That agent picks up 2.0.0 on its own: after the pull it re-runs the patcher, which restores the pristine `app.asar` from the backup, builds the renderer cache, installs the host agent, and retires itself. The host then offers to restart the running Codex once, because the old in-place patch stays loaded until it restarts. Nothing has to be run by hand.

## Updates

Releases are semver Git tags such as `1.0.0`; commits pushed without a new tag are never installed automatically. Every five minutes the host asks the remote for its release tags. When a newer release exists, it fast-forwards the checkout, rebuilds the renderer cache, and restarts itself, which reloads Codex's windows with the new bundles. If Codex is running, a dialog offers to restart now; Later postpones the restart until Codex quits. An unreachable remote is logged and retried on the next tick.

Automatic updates follow `~/.codex/.codex-mod-config.json`: `{"automaticUpdates": false}` turns them off, in which case updating means `git pull` followed by `make install`.

## Codex updates

Codex replaces `app.asar` when it updates itself. The host notices that the cache no longer matches the installed build the next time Codex launches, rebuilds it, and reloads the windows once the rebuild finishes. Until then Codex runs stock; if the patterns no longer match the new build, the host keeps serving stock bundles and logs the failure.

## Uninstall

```sh
make uninstall
```

This stops and removes the launch agent, removes the renderer cache and the mod's state files, and leaves Codex running unmodified. Installs from releases that patched `app.asar` in place are restored from the pristine backup under `~/.codex/backups/codex-app-asar`; that single step writes into the application bundle and is the only one that needs the App Management permission for the terminal.

## How cross-provider continuation works

Codex threads persist the model provider they were started with, and stock Codex resumes a thread under that stored provider. The patched renderer overrides the thread resume request with the active profile instead, using the same protocol field Codex itself uses for its Copilot proxy mode. An existing chat therefore continues in place under the newly selected provider, with its full visible history and without creating a duplicate thread.

The host persists the active provider for the renderer, and switching profiles restarts the local Codex host so new chats also start under the selected provider.

Because history is replayed to the new provider as-is, both providers should serve compatible models (for example an OpenAI-compatible proxy exposing the same model ids). A provider that rejects another provider's reasoning payloads will fail the first turn after a switch; switching back restores the original provider.

## Security note

While Codex runs with the mod, its DevTools port is open on localhost. Any process running as the same user could attach to it and script the Codex window. The port is configurable with `CODEX_MOD_CDP_PORT` in the host's environment.

## Patch revisions

Public versions are semver Git tags; see `AGENTS.md` for the release convention. The renderer cache records the release, the Git describe output and the patcher commit it was built from in its `manifest.json`, and the host logs them on startup. Injected components use hashes derived from their content, so changing the injected source automatically replaces an older revision without a manually maintained counter.
