# `slack-notify`

Post a Block Kit card to a Slack channel with `chat.postMessage`, optionally followed by
the long version as replies in the card's thread.

The Slack counterpart of [`teams-notify`](../teams-notify). It takes the same `title` / `text` / `status` /
`facts` / `button-*` inputs, so moving a caller over means changing `uses:`, the token env
var, and adding `channel`. Layout follows the org Slack style: card = summary, thread = everything.

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
    SLACK_BOT_TOKEN: ${{ env.SLACK_BOT_TOKEN }}
  with:
    channel: ${{ env.SLACK_CHANNEL_DEVS_DEPLOYS }}
    username: Houston · Deploys
    icon-emoji: ':rocket:'
    title: vector deployed to prod
    summary: Migrations applied, health check green.
    status: success
    facts: '[{"name":"Version","value":"v1.4.0"},{"name":"Took","value":"4m"}]'
    button-url: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
    button-label: View run
    thread-text: ${{ steps.migrate.outputs.log-tail }}   # optional; goes in the card's thread
```

## Inputs

| Input | Required | Default | Description |
|---|:---:|---|---|
| `channel` | yes | — | Channel **ID** (`C…`), not `#name`. Survives renames. |
| `title` | yes | — | Bold title, linked to `button-url` when set, and the notification preview. Clipped at 150 chars. |
| `summary` | no | `''` | One sentence under the title. Converted like `text`. Clipped at 2000 chars. |
| `context` | no | repo · run · branch · actor | Small grey line above the title, Slack mrkdwn (`[label](url)` converted). |
| `text` | no | `''` | Body under the title, Slack mrkdwn. `**bold**` and `[label](url)` are converted. Clipped at 3000 chars. Prefer `summary` + `thread-text`. |
| `status` | no | `info` | `info` / `success` / `warning` / `failure`. Sets the colour bar. Invalid values fail the step. |
| `facts` | no | `[]` | JSON array of `{"name","value"}`, rendered as a two-column grid, 10 per section. Must be an array. Keep values short; no prose. |
| `button-url` | no | `''` | Adds a link button beside the title. |
| `button-label` | no | `View` | Button label. Clipped at 75 chars. |
| `button-style` | no | `''` | `primary` (green), `danger` (red), or empty for the default. Invalid values fail the step. |
| `thread-text` | no | `''` | Posted as replies in the card's thread right after the card. Converted like `text`. Split on line boundaries into ≤ 2900-char replies, never truncated. |
| `thread-ts` | no | `''` | `ts` of an existing message. The card, and any `thread-text` replies, go in that message's thread. |
| `username` | no | `''` | Sender name for this message, e.g. `Houston · Deploys`. Needs `chat:write.customize`. |
| `icon-emoji` | no | `''` | Sender icon, e.g. `:rocket:`. Needs `chat:write.customize`. |
| `dry-run` | no | `false` | Build and print the payloads without posting. |

## Outputs

| Output | Description |
|---|---|
| `payload` | The card's JSON payload (sent, or that would have been sent under `dry-run`). |
| `thread-payloads` | JSON array of the `thread-text` reply payloads, `[]` without it. `thread_ts` is added at post time, so it is absent here. |
| `ts` | Timestamp of the posted card. Pass it as another call's `thread-ts`, or use it with `chat.update`. Empty under `dry-run`. |

## Required env

| Env var | Description |
|---|---|
| `SLACK_BOT_TOKEN` | A bot token (`xoxb-…`) with `chat:write`. Add `chat:write.public` to post to public channels the bot hasn't joined. |

**Not an input, deliberately.** Per [CONTRIBUTING.md](../../CONTRIBUTING.md), secrets go through
`env:` at the call site. Each Slack app keeps its tokens under its own Infisical folder
(`/slack/houston`, …) with the same key names, so loading one folder gives you `SLACK_BOT_TOKEN`.

## Message layout

One attachment, coloured by `status` (a legacy attachment colour is Slack's only accent):

- context: `context`, or repo · run · branch · actor, each linked where it can be
- **title** (linked to `button-url`) with `summary` under it and the button on the right
- `text`, when given
- `facts` grid

`text` fallback (notifications, screen readers) is the title. With `thread-text`, the
replies follow immediately in the card's thread, one section each. Link unfurling is off
on every message, so a GitHub URL doesn't expand into a preview that buries the card.

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

**Replies fail the step too.** The card's `ts` is written before the replies post, so a
failed reply leaves the output set and the step red. Long `thread-text` is still bounded by
the runner's per-variable env limit (~128 KB); write anything bigger to a file and link it.

**Link buttons still send a click event** to the Slack app. Until the app has a listener,
Slack may show a small warning icon after a click. The link itself opens fine.

**Notify on transitions, not on a timer.** Same advice as `teams-notify`: a daily "still
broken" trains people to mute the channel.
