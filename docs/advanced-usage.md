# Codex Mod advanced usage

[Back to the product overview](../README.md)

## Configure providers

The built-in `openai` provider is always available. Every top-level `[model_providers.<id>]` section becomes another menu option under the Profiles heading, using its configured `name`. The host rereads `config.toml` every ten seconds, so a section added while Codex is running appears in the menu without restarting anything.

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

Clicking the header row of Codex's profile menu, the entry that shows the signed-in account or the active profile, opens the switcher card beside it. The card presents an Accounts section above the Profiles section with the custom providers. Each account entry stands for the built-in OpenAI provider under that ChatGPT login, so the Accounts section stays empty while no account is captured yet, and an account row is marked active only while the OpenAI provider is selected; the active entry is shown as a filled row. Selecting an account activates the OpenAI provider, injects the stored login into `~/.codex/auth.json`, restarts the local Codex host, and reloads the windows in one step. After a profile or account switch the thread that was open is reopened, as long as its sidebar entry is visible. Entries are labelled with the account's name and plan from the login's identity token, falling back to the email address. The plus button on the Accounts heading starts the add-account flow, and hovering an account row reveals an X that forgets the stored login after confirmation; forgetting the signed-in account also signs Codex out, since it would otherwise be captured again right away. Signing out through Codex itself revokes that login with OpenAI, so the account disappears from the switcher as well; sign in again to add it back.

Accounts are captured automatically. Every ten seconds the host compares the live `auth.json` with its account store in `~/.codex/.codex-mod-accounts/`; an unknown ChatGPT login is snapshotted as a new account, and the active account's snapshot is refreshed whenever Codex rotates its tokens. The add-account flow backs up the current login and takes Codex to the sign-in screen, stopping running threads; the account logged in there is captured automatically. Logging out and back in through the normal Codex UI works just as well. API-key logins are not captured; adding an account signs one out like any other login, and it has to be entered again to use it.

The signed-out screen has no sidebar, so it gets a Saved accounts pill below the stock sign-in buttons that expands into the saved accounts and profiles; selecting one signs in or switches exactly like the sidebar menu.

The refresh write-back matters because OpenAI refresh tokens are single-use: a snapshot that misses a rotation becomes permanently invalid. If a stored account stops working, for example after using the same login on another machine, log in with it once more to re-capture it. Before the first switch the previous `auth.json` is preserved once as `auth.json.bak.before-profile-switcher`.

## Browser tools under custom profiles

Codex's Chrome and browser tools need a ChatGPT login even when the chat itself runs on a custom provider: they look up the account and check every page they act on against OpenAI's backend. They read the login from an app-server of their own, and an app-server hands the login out only while the active provider requires OpenAI auth, so under a custom profile the tools fail with "Codex auth token is unavailable".

The Enable Chrome extension fix switch in the Codex Mod section of Settings > General lets the tools use the signed-in ChatGPT login under custom profiles. It is off by default and only shown while `auth.json` holds a ChatGPT login. Flipping it saves the setting and asks whether to restart Codex now, which stops running threads, or later, in which case the change applies the next time the host launches Codex. While it is on, the tools send the address of every page they act on, including its query string, and usage telemetry to OpenAI under that account; model requests keep going to the active provider, and the profile menu keeps showing the custom profile.

With the switch on, the host launches Codex with `CODEX_CLI_PATH` pointing to a wrapper in `~/.codex/.codex-mod-cli/`. Codex hands that path to the tools, and the wrapper runs only the app-server the tools start under the OpenAI provider; every other call reaches the bundled CLI unchanged. The setting is stored as `"browserToolsUseChatGPTLogin": true` in `~/.codex/.codex-mod-config.json`. Turning it off removes the wrapper, and Codex writes its bundled CLI back into `config.toml` on the next launch.

## Usage status

The mod shows a status box at the bottom of the sidebar's chat list, beside the profile button in Codex's app rail; builds without the rail show it above the sidebar footer instead. Its contents depend on the active provider.

While the sidebar is collapsed, the same status moves into a single row under the thread's composer: each window side by side with its label, bar, percentage, and reset countdown, or for a custom provider one bar with the spend and budget. The row follows the main chat's composer; a side chat or the browser panel's floating composer only gets it while no main chat is on screen. While a turn runs, the floating panel shows a status bar instead of its composer, and the row sits under that status bar. On a narrow composer the reset countdowns are dropped first. When the last refresh failed the row dims its bars and ends in a red "Refresh failed", with the reason on hover. The muted notes for a profile or account without usage limits stay in the sidebar; with the sidebar collapsed, no row is shown for them.

### Custom providers

For a custom provider the box shows the key's spend, budget limit, and reset countdown. The data comes from the provider's LiteLLM-style `/key/info` endpoint, derived from `base_url` without the `/v1` suffix, authorized with the key from the provider's `env_key` environment variable.

The host resolves that variable the way Codex does: it reads the login shell's environment at startup, so a key exported in `~/.zshrc` or `~/.zprofile` is found even though launch agents start with a minimal environment. Oh My Zsh's update check is turned off for that shell, since it hangs without network, and a shell that still fails, for example at login before the network is up, is retried every minute until it succeeds. The box only appears when the variable is set there and the endpoint returns a valid budget.

### OpenAI

For the built-in `openai` provider the box shows the ChatGPT plan's rate limit windows, one bar per active window, labelled by window length with a reset countdown. A window only starts counting down with the first message sent in it, so an untouched window reads "not started" instead of a countdown that would restart on first use.

OpenAI currently exposes a single weekly window. A shorter window, such as the 5-hourly one, appears as a second bar automatically whenever the account reports it. Windows are ordered shortest first, independent of the slot the backend reports them in, so the row order stays stable and the window worth acting on stays on top.

When the account holds unused rate limit resets, a green pill next to the longest window's label reports how many are available and opens Codex's own usage reset dialog. Resets clear the account rather than a single window, so the pill deliberately avoids the short window's row. The pill is hidden when no resets are available, and also when the renderer bridge that opens the dialog is missing, so it is never a dead button. On a narrow sidebar the reset countdown is dropped before the pill.

The numbers are the ones the Desktop app shows itself: the patched renderer hands every usage response the app fetches for its own display to the host, which updates the box in all windows right away. The app refetches after each message it sends and about once a minute otherwise, so the box never trails the app's own usage summary. That response also carries the reset-credit count, which the app refetches right after a reset is redeemed, so the pill follows it as well. As a fallback the host polls the bundled Codex binary's `account/rateLimits/read` app-server method once a minute while no renderer reports arrive. All of it requires a ChatGPT login; an API-key login reports no rate limits and the box stays hidden. Usage is tracked per account: switching accounts, through the switcher or by signing in through Codex, clears the box until the new account's usage arrives, and responses fetched for the previous account are dropped.

Single failed refreshes are only logged, since they usually recover on the next poll. Once three refreshes in a row fail, for either provider, the box keeps the last known bars, dims them, and shows an alert underneath naming the failure, such as a timed-out app server or an unreachable proxy. If nothing was ever fetched it shows the alert alone. A custom profile whose provider has no budget endpoint, or none configured, keeps the row's frame with an empty track and no reading and says "No usage data for this profile" where the amounts go; a ChatGPT account without usage limits, such as a business workspace whose admin set none, shows "Unlimited" under a track filled end to end with the blue and violet of the model picker's Ultra slider, slowly sweeping through the track, a look off the usage scale. The box only disappears for an API-key login, which reports no rate limits at all.

### Version

Settings > General ends with a Codex Mod section that names the release the host serves to that window, for example `2.1.0`. A checkout ahead of a release shows the `git describe` output next to it, such as `2.1.0 (2.1.0-3-g7719e7a)`. The same values are logged by the host on startup. The section also holds the Chrome extension fix switch and the Uninstall button described below.

### Dialogs

Every confirmation and error the mod raises, such as adding or forgetting an account, a failed switch, or an available update, appears as a modal inside the Codex window, styled like the app's own dialogs. Enter picks the default action and Escape cancels; a dialog whose default is Cancel leaves only its destructive button colored. When no Codex window is attached, for example while Codex is starting, the same dialog falls back to a native macOS alert.

## Chats and profiles

Codex threads persist the model provider they were started with, and a thread always resumes under that provider. New chats start under the active profile; switching profiles restarts the local Codex host so that takes effect at once.

A chat of another profile is greyed in the sidebar, and a notice in place of its composer names the profile the chat belongs to and offers to fork it. The fork starts a new chat under the active profile, named after the original with the next free number in brackets as Codex names its own forks, and hands it the original's history as plain messages: the prompts, the model's answers, and the tool activity (commands with their output, file changes, tool calls, web searches) summarized as text inside the answers. The history opens with the original's thread ID so the model can read the full chat with its `read_thread` tool when it needs more detail. Each item is clipped, and the whole history is capped at about 400,000 characters, dropping tool detail and then whole turns from the start. Plain messages carry no reasoning, so any provider accepts them; reasoning items hold content encrypted for the organization that produced it, and replaying them to another provider fails with `invalid_encrypted_content`. The forked chat's transcript starts empty, because injected history is not made of turns; a chip above its composer says how many turns the model can see, and Hide dismisses it. The original chat stays as it is. Switching between OpenAI accounts needs no fork, since they share the provider.

The lock and the fork rely on a renderer bridge that registers Codex's thread manager. Under a Codex build the patcher does not recognize, chats of other profiles are not locked, and their first turn fails as it does in stock Codex.

## Hidden turns after an interrupted chat

Codex stores a thread as a chain of rollout segment files with increasing record ordinals. When Codex is quit or dies while a turn is running, for example after a usage-limit error, no abort record is written, and the next resume continues in the same segment with an ordinal counter that restarts one too low. Codex's history reader stops at the first repeated ordinal, so every later turn is missing from the transcript after a reload even though it is on disk; the live session still loads the whole file, so the chat keeps working with full context until the next reload. This is a Codex bug, but profile switches and relaunches make interrupted turns more common.

The host repairs affected files whenever Codex is not running: at host start and each time Codex quits, it scans rollouts modified since the previous scan, renumbers the tail of every segment whose ordinals regress, adjusts the segments that branch off it, and keeps the original next to the file as `*.bak-before-renumber`. Repaired threads show their full history at the next launch. The same scan runs on demand with

```sh
make repair-rollouts
```

after quitting Codex; `REPAIR_ARGS=--dry-run` only reports what would change. A regression inside a thread's first segment whose fix would move bytes is left alone and logged, because Codex keeps byte offsets into that segment.

## Security note

While Codex runs with the mod, its DevTools port is open on localhost. Any process running as the same user could attach to it and script the Codex window. The port is configurable with `CODEX_MOD_CDP_PORT` in the host's environment.
