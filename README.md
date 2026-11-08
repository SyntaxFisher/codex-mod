# Codex Mod

Switch between ChatGPT accounts and custom AI providers in Codex Desktop, with usage limits visible while you work. Codex Mod is an unofficial macOS companion that adds these controls to the app.

[Installation](#install) · [Advanced usage](docs/advanced-usage.md) · [Report a problem](https://github.com/SyntaxFisher/codex-mod/issues/new)

## Features

- Switch saved ChatGPT accounts and configured providers from the profile menu.
- See supported usage limits, remaining budgets, and reset countdowns in the sidebar or below the composer.
- Find recent and archived chats across providers.
- Continue a chat with another provider by creating a fork with its conversation history.
- Receive tagged updates automatically, with a choice of when to reload your windows.

## Requirements

- macOS with Codex Desktop installed as `/Applications/ChatGPT.app` or `/Applications/Codex.app`.
- A ChatGPT login, or a custom provider configured in `~/.codex/config.toml`.

Codex Mod runs on the Node.js bundled with Codex, so nothing else needs to be installed. Compatibility depends on the installed Codex build; if an update changes the expected app structure, the mod serves the original interface until it supports that build.

## Install

Finish any running chats before installing: installation can restart Codex and stop active work. Then run this in Terminal:

```sh
curl -fsSL https://github.com/SyntaxFisher/codex-mod/releases/latest/download/install.sh | sh
```

The installer downloads the newest release into `~/Library/Application Support/codex-mod`, checks it against its published SHA-256 checksum, and starts the companion. The companion runs in the background and starts when you sign in to your Mac. Open Codex normally from then on.

Running the command again reinstalls the newest release. To give the mod a separate Codex home, or to install from a clone of this repository, see the [installation reference](docs/development.md#install).

If you installed an earlier release by cloning the repository, you do not need to do anything: the companion moves itself to the new location with its next update and deletes the clone. If you turned automatic updates off, run the command above instead, which does the same. A clone with uncommitted changes or commits that were never pushed is kept.

## Use

Open Codex's profile menu and click the row showing your account or active profile. The switcher lists saved **Accounts** and custom **Profiles**. When your login belongs to more than one workspace, that row opens Codex's own workspace list instead, and your other saved accounts and profiles appear below the workspaces in the same list.

- **Accounts:** your current ChatGPT login is captured automatically. Use the plus button to add another login, or select a saved account to switch. Adding an account takes you through sign-in and stops running chats. Each person appears once: switching to another workspace of the same login through Codex keeps that saved account and remembers the workspace for the next switch back.
- **Profiles:** providers configured in `~/.codex/config.toml` appear automatically. See the [configuration example](docs/advanced-usage.md#configure-providers) to add one.
- **Chats:** a chat belonging to another provider is greyed out. Open it and choose to fork it to continue under the active provider. The original stays unchanged; the new chat receives history as text, with detail limited for long conversations. Switching between ChatGPT accounts uses the same provider and needs no fork.
- **Usage:** ChatGPT accounts show available rate-limit windows. Custom providers show spend and budget when they offer a compatible usage endpoint. An API-key login does not show ChatGPT usage limits.

Finish active work before switching profiles or accounts, because switching restarts the local Codex host and reloads windows.

Under **Settings → General → Codex Mod**, you can see the installed version, uninstall the companion, or enable the optional Chrome/browser tools fix. The fix is off by default and uses a saved ChatGPT login for browser tools while your model requests continue to use the selected provider. Read its [data-sharing behavior](docs/advanced-usage.md#browser-tools-under-custom-profiles) before enabling it.

## Privacy and permissions

Provider settings stay in the normal Codex configuration. Saved ChatGPT logins are stored locally in `~/.codex/.codex-mod-accounts/`; switching accounts writes the selected login into Codex's `auth.json`. These files contain credentials. Signing out through Codex revokes that login and removes it from the switcher.

The companion checks this repository's GitHub releases for updates and queries OpenAI or the configured provider for available usage information. The optional browser tools fix sends the addresses of pages the tools act on, including query strings, and usage telemetry to OpenAI under your ChatGPT account.

The mod connects to a local debugging port to add its controls. Other processes running as your user could use that port to control the Codex window. No additional macOS privacy permissions are required for a new installation, and the installed Codex application is not modified.

## Updates and uninstall

The companion checks for a newer release every five minutes. When an update needs to reload open windows, you can apply it now or postpone it until Codex quits. Running chats continue through an update reload, but an unsent draft is lost. See [update settings](docs/development.md#updates) to disable automatic updates or update manually.

To uninstall, choose **Uninstall** under **Settings → General → Codex Mod**, or run:

```sh
curl -fsSL https://github.com/SyntaxFisher/codex-mod/releases/latest/download/install.sh | sh -s -- --uninstall
```

The in-app option restarts Codex and stops running chats. Saved account logins remain on disk; see the [uninstall reference](docs/development.md#uninstall) for details.

## Support

[Open an issue](https://github.com/SyntaxFisher/codex-mod/issues/new) with your macOS version, Codex version, Codex Mod version, and steps to reproduce the problem. Logs are in `~/Library/Logs/codex-mod/host.log`. Remove credentials and private information before sharing logs; do not upload `auth.json` or saved account files.

See [advanced usage](docs/advanced-usage.md) for account recovery, usage display behavior, and interrupted chat history.

## Development

See [architecture, development, and versioning](docs/development.md).
