# `assert-prod-deployer`

Fail the job unless `github.triggering_actor` is in the `PROD_DEPLOYERS` org variable.
The VPS deploy, rollback and copy-db workflows run it first for `prod`/`production`;
AWS deploy workflows (lumios, vector) call it themselves.

```yaml
- uses: Lumist-Labs/github-actions/actions/assert-prod-deployer@v2
  with:
    deployers: ${{ vars.PROD_DEPLOYERS }}
```

| Input | Required | Description |
|---|---|---|
| `deployers` | yes | `vars.PROD_DEPLOYERS`, passed in because a composite can't read `vars` |

Behaviour, in order:

- Repo owner is not `Lumist-Labs` → notice and pass. The variable and the `core` team
  exist only in that org, and aretecp repos call the same workflows.
- `deployers` empty → fail ("empty or not visible to this repo").
- Not a JSON array → fail.
- Actor not in the array → fail, printing the list.

`PROD_DEPLOYERS` is managed in `lumist-terraform-infrastructure/github/actions.tf`.
Add a person there, not in the GitHub UI. It includes `github-actions[bot]` and
`lumist-release-bot[bot]` so a release's own deploy dispatch passes.
