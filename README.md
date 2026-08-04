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
- App Management permission for the terminal used to patch Codex

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

## Budget status

When the active provider is a custom provider, the patch shows a budget box above the sidebar footer with the key's spend, budget limit, and reset countdown. The data comes from the provider's LiteLLM-style `/key/info` endpoint, derived from `base_url` without the `/v1` suffix, authorized with the key from the provider's `env_key` environment variable.

The box only appears when that environment variable is set in the Codex process and the endpoint returns a valid budget. GUI-launched apps do not inherit shell environment variables, so export the key for GUI apps (for example via `launchctl setenv`) or launch Codex from a terminal that has it.

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

## Update to the latest patch

The patcher pulls the latest patch sources automatically before patching, both when `make patch` runs and when the LaunchAgent re-patches. If the pull fails, for example while offline, patching continues with the local sources. Dry runs never pull.

## Keep the patch installed after updates

Install and start the LaunchAgent:

```sh
make install
```

The watcher runs the patcher when the installed ASAR or patch source changes. It does not launch Codex.

Stop and remove it with:

```sh
make uninstall
```

`make install` installs dependencies, validates the sources, writes the LaunchAgent plist, and starts the watcher. `make uninstall` stops the watcher and removes its plist.

## How cross-provider continuation works

Codex threads persist the model provider they were started with, and stock Codex resumes a thread under that stored provider. The patch overrides the thread resume request with the active profile instead, using the same protocol field Codex itself uses for its Copilot proxy mode. An existing chat therefore continues in place under the newly selected provider, with its full visible history and without creating a duplicate thread.

The profile switcher persists the active provider for the renderer, and switching profiles restarts the local Codex host so new chats also start under the selected provider.

Because history is replayed to the new provider as-is, both providers should serve compatible models (for example an OpenAI-compatible proxy exposing the same model ids). A provider that rejects another provider's reasoning payloads will fail the first turn after a switch; switching back restores the original provider.

## Patch revisions

There is no manually maintained patch counter. Injected components use hashes derived from their content, so changing the injected source automatically replaces an older revision. Use Git tags or releases for public version numbers when needed.
