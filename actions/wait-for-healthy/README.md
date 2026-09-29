# `wait-for-healthy`

Poll `docker inspect` on a deploy target over SSH until every named container reports
`healthy`. On timeout, dump that compose project's logs and fail.

It wraps [`scripts/wait-for-healthy.sh`](../../scripts/wait-for-healthy.sh). The script
is base64'd from this action's own checkout and piped to `bash` over the SSH
connection, so nothing on the host fetches a URL. A raw GitHub URL carries the org
name and breaks on a repo transfer; a `uses:` ref does not.

```yaml
- uses: Lumist-Labs/github-actions/actions/wait-for-healthy@v2
  with:
    host: ${{ env.VPS_TAILSCALE_IP }}
    username: ${{ inputs.vps-user }}
    key: ${{ env.VPS_SSH_KEY }}
    containers: myapp_app myapp_db
    compose-file: /home/sglyon/myapp/docker-compose.prod.yml
    env-file: /home/sglyon/myapp/.env
```

| Input | Required | Default | Description |
|---|---|---|---|
| `host` | yes | — | SSH host (the deploy target) |
| `username` | yes | — | SSH user |
| `key` | yes | — | SSH private key |
| `containers` | yes | — | Space-separated container names; all must reach `healthy` |
| `compose-file` | no | `''` | Absolute host path, used only for the timeout log dump. Omit and a timeout has no logs |
| `env-file` | no | `''` | Absolute host path passed as `--env-file` to the log dump |
| `timeout-seconds` | no | `150` | Total wait |
| `poll-interval` | no | `5` | Seconds between polls |
| `log-tail` | no | `100` | Lines per container in the dump |
| `command-timeout` | no | `5m` | SSH timeout; must exceed `timeout-seconds` or the failure reads as a network error |

No outputs. Paths must be absolute: `~` does not expand inside the quoted variable the
script receives.

Both ends refuse an empty script, because `bash -s` on empty stdin exits 0 and would
report healthy without inspecting anything. The script stays at the repo root because
tags `v1` and earlier still serve it over raw URLs to unmigrated hosts.
