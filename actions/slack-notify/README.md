# `slack-notify`

Post a Block Kit message to a Slack channel with `chat.postMessage`.

The Slack counterpart of [`teams-notify`](../teams-notify). It takes the same `title` / `text` / `status` /
`facts` / `button-*` inputs, so moving a caller over means changing `uses:`, the token env
var, and adding `channel`.

## Usage

```yaml
- name: Load Slack bot token and channels
  uses: Lumist-Labs/github-actions/actions/load-infisical-secrets@v2
  with:
    method: oidc
    identity-id: ${{ vars.INFISICAL_OIDC_IDENTITY_ID }}
    project-slug: ${{ vars.INFISICAL_SHARED_PROJECT_SLUG }}
    environment: prod
    path: /slack/houston

- name: Load Slack channel IDs
  uses: Lumist-Labs/github-actions/actions/load-infisical-secrets@v2
  with:
    method: oidc
    identity-id: ${{ vars.INFISICAL_OIDC_IDENTITY_ID }}
    project-slug: ${{ vars.INFISICAL_SHARED_PROJECT_SLUG }}
    environment: prod
    path: /slack/channels

- name: Notify Slack
  uses: Lumist-Labs/github-actions/actions/slack-notify@v2
  env:
    SLACK_BOT_TOKEN: ${{ env.HOUSTON_SLACK_BOT_TOKEN }}
  with:
    channel: ${{ env.SLACK_CHANNEL_DEVS_DEPLOYS }}
    username: Houston · Deploys
    icon-emoji: ':rocket:'
    title: vector deployed to prod
    status: success
    text: Migrations applied, health check green.
    facts: '[{"name":"Version","value":"v1.4.0"},{"name":"Took","value":"4m"}]'
    button-url: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
    button-label: View run
```

## Inputs

| Input | Required | Default | Description |
|---|:---:|---|---|
| `channel` | yes | — | Channel **ID** (`C…`), not `#name`. Survives renames. |
| `title` | yes | — | Header, and the notification preview. Clipped at 150 chars. |
| `text` | yes | — | Body, Slack mrkdwn. `**bold**` and `[label](url)` are converted. Clipped at 3000 chars. |
| `status` | no | `info` | `info` / `success` / `warning` / `failure`. Sets the colour bar. Invalid values fail the step. |
| `facts` | no | `[]` | JSON array of `{"name","value"}`, rendered as a two-column grid, 10 per section. Must be an array. |
| `button-url` | no | `''` | Adds a link button. |
| `button-label` | no | `View` | Button label. |
| `username` | no | `''` | Sender name for this message, e.g. `Houston · Deploys`. Needs `chat:write.customize`. |
| `icon-emoji` | no | `''` | Sender icon, e.g. `:rocket:`. Needs `chat:write.customize`. |
| `dry-run` | no | `false` | Build and print the payload without posting. |

## Outputs

| Output | Description |
|---|---|
| `payload` | The JSON payload sent (or that would have been sent under `dry-run`). |
| `ts` | Timestamp of the posted message. Use it as `thread_ts` to reply in thread, or with `chat.update`. Empty under `dry-run`. |

## Required env

| Env var | Description |
|---|---|
| `SLACK_BOT_TOKEN` | A bot token (`xoxb-…`) with `chat:write`. Add `chat:write.public` to post to public channels the bot hasn't joined. |

**Not an input, deliberately.** Per [CONTRIBUTING.md](../../CONTRIBUTING.md), secrets go through
`env:` at the call site. The name is generic because any Slack app can post through this
action: map your app's token onto it (`SLACK_BOT_TOKEN: ${{ env.HOUSTON_SLACK_BOT_TOKEN }}`).

## Message layout

- **Header**: `title`.
- **Colour bar** (legacy attachment colour; Block Kit has no accent of its own) beside:
  - `text`
  - `facts` grid
  - button
  - footer: repo (linked to the run) · short SHA · actor

Link unfurling is off, so a GitHub URL in the body doesn't expand into a preview that buries the message.

## Status colours

| Status | Colour | Use for |
|---|---|---|
| `info` | `#6957D8` | Routine notices. Lumist iris. |
| `success` | `#2EA043` | Completion. |
| `warning` | `#D29922` | Action starting, approval needed, deadline approaching. |
| `failure` | `#B60205` | Something broke or stalled. |

## Notes

**Slack's `ok: false` fails the step.** `chat.postMessage` answers HTTP 200 even for a bad
token, an unknown channel or a missing scope, with the reason in the body. The action
checks `ok` and fails with Slack's `error` string (`invalid_auth`, `channel_not_found`,
`not_in_channel`, `missing_scope`). This keeps `teams-notify`'s contract that a broken
notifier is a red run, not a silence.

**Link buttons still send a click event** to the Slack app. Until the app has a listener,
Slack may show a small warning icon after a click. The link itself opens fine.

**Notify on transitions, not on a timer.** Same advice as `teams-notify`: a daily "still
broken" trains people to mute the channel.
