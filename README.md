# codex-mod

An unofficial macOS patch for switching Codex Desktop between the built-in OpenAI provider and custom providers configured in `~/.codex/config.toml`.

The patch adds an icon-only provider menu beside the profile footer, makes recent and archived chats visible across providers, and continues every chat under the active provider, even when the chat was started under a different one.

## Important

This modifies `app.asar` inside the installed Codex application. It is unsupported, may trigger macOS application-management or security prompts, and can break whenever Codex Desktop changes its renderer bundles. The patcher validates known bundle patterns and refuses to continue when they no longer match.

The patcher creates a content-addressed backup under `~/.codex/backups/codex-app-asar` before replacing `app.asar`.

## Requirements

- macOS
- Codex Desktop installed as `/Applications/ChatGPT.app` or `/Applications/Codex.app`
- Python 3.10 or newer
- Node.js and npm for installing `@electron/asar`
- App Management permission for the terminal used to patch Codex, and for the Python interpreter in the LaunchAgent's `ProgramArguments` when the watcher is installed

## Configure providers

The built-in `openai` provider is always available. Every top-level `[model_providers.<id>]` section becomes another menu option, using its configured `name`.

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

## Usage status

The patch shows a status box above the sidebar footer. Its contents depend on the active provider.

### Custom providers

For a custom provider the box shows the key's spend, budget limit, and reset countdown. The data comes from the provider's LiteLLM-style `/key/info` endpoint, derived from `base_url` without the `/v1` suffix, authorized with the key from the provider's `env_key` environment variable.

The box only appears when that environment variable is set in the Codex process and the endpoint returns a valid budget. GUI-launched apps do not inherit shell environment variables, so export the key for GUI apps (for example via `launchctl setenv`) or launch Codex from a terminal that has it.

### OpenAI

For the built-in `openai` provider the box shows the ChatGPT plan's rate limit windows, one bar per active window, labelled by window length with a reset countdown.

OpenAI currently exposes a single weekly window. A shorter window, such as the 5-hourly one, appears as a second bar automatically whenever the account reports it. Windows are ordered shortest first, independent of the slot the backend reports them in, so the row order stays stable and the window worth acting on stays on top.

When the account holds unused rate limit resets, a green pill next to the longest window's label reports how many are available and opens Codex's own usage reset dialog. Resets clear the account rather than a single window, so the pill deliberately avoids the short window's row. The pill is hidden when no resets are available, and also when the renderer bridge that opens the dialog is missing, so it is never a dead button. On a narrow sidebar the reset countdown is dropped before the pill.

The data comes from the bundled Codex binary's `account/rateLimits/read` app-server method, which is the same source the Desktop app uses for the usage summary in its profile menu. It requires a ChatGPT login; an API-key login reports no rate limits and the box stays hidden. Because each read starts a short-lived app server, this provider is polled once a minute rather than on the ten-second budget interval.

## Patch Codex

Close Codex first, then run:

```sh
make patch
```

Dependencies and source validation run automatically. To validate without changing the application:

```sh
make dry-run
```

For a non-default installation, override `APP` or `ASAR`:

```sh
make patch APP=/Applications/Codex.app
make dry-run ASAR=/path/to/app.asar
```

## Updates and the Codex Mod menu

Releases are semver Git tags such as `1.0.0`; commits pushed without a new tag are never installed automatically. The patch adds a `Codex Mod` menu to the macOS menu bar with three entries:

- The installed version. Development builds installed with `make patch` additionally show the `git describe` output, for example `Version 1.0.0 (1.0.0-3-gabc1234)`.
- `Check for Updates…` triggers the LaunchAgent, which pulls the sources when a newer release tag exists on the remote and re-patches. The app then offers to restart, reports that the patch is up to date, or shows what failed.
- `Keep Codex Patched Automatically` toggles the watcher between its two modes, described below.

When an update lands in the background, for example after a Codex update replaced `app.asar` or a new release tag appeared, the app shows the same restart dialog as a manual check. `make patch` on a newer release behaves the same way: it pulls before patching whenever a newer release tag exists.

## Keep the patch installed after updates

`make patch` installs and starts the LaunchAgent automatically; there is no separate install step. The agent has two modes, toggled from the `Codex Mod` menu:

- Automatic (`Keep Codex Patched Automatically` checked, the default): the agent re-runs the patcher when the installed ASAR changes and checks the remote for a new release tag every five minutes.
- Manual (unchecked): the agent stays installed but only runs when `Check for Updates…` triggers it. It stays installed because macOS attributes bundle writes to the process doing them, and the agent's Python interpreter is the one holding the App Management grant; running the patcher from inside Codex would require granting App Management to Codex itself.

Replacing `app.asar` needs App Management permission, and macOS attributes that to the process doing the write: the terminal application for `make patch`, but the Python interpreter itself for the watcher, because a LaunchAgent has no parent application. They are separate grants, and a dismissed prompt is cached as a denial that is never asked again. Every run therefore checks that the bundle is writable before doing any work and reports which process needs the grant, rather than failing at the last step of a full repack. `make dry-run` reports the same check as `bundle writable`.

macOS can watch local files but not a Git remote, so new releases are found by asking for them. Every five minutes the watcher compares the installed ASAR and the newest remote release tag against the last completed run, recorded in `~/.codex/.codex-mod-state.json`. When both match it exits in about a second, having transferred nothing but the tag list; only a real change pulls and repacks the ASAR. An unreachable remote counts as unchanged, so an offline machine stays idle instead of repacking on every tick.

Remove the agent entirely with:

```sh
python3 scripts/manage_launch_agent.py uninstall
```

## How cross-provider continuation works

Codex threads persist the model provider they were started with, and stock Codex resumes a thread under that stored provider. The patch overrides the thread resume request with the active profile instead, using the same protocol field Codex itself uses for its Copilot proxy mode. An existing chat therefore continues in place under the newly selected provider, with its full visible history and without creating a duplicate thread.

The profile switcher persists the active provider for the renderer, and switching profiles restarts the local Codex host so new chats also start under the selected provider.

Because history is replayed to the new provider as-is, both providers should serve compatible models (for example an OpenAI-compatible proxy exposing the same model ids). A provider that rejects another provider's reasoning payloads will fail the first turn after a switch; switching back restores the original provider.

## Patch revisions

Public versions are semver Git tags; see `AGENTS.md` for the release convention. The patcher bakes the installed release into the application as `codex-mod-version.json`, which is what the `Codex Mod` menu displays. Injected components additionally use hashes derived from their content, so changing the injected source automatically replaces an older revision without a manually maintained counter.
