# `ecr-build-push`

Assume an AWS role via OIDC and get an image into ECR tagged by an immutable `sha` and an
optional `version`. If `<repository>:<sha>` already exists it only adds the `version`
tag and never rebuilds, which makes a rollback a retag.

Pairs with [`aws-deploy-core`](../aws-deploy-core), which deploys but does not build.
Used by lumios and vector.

```yaml
permissions:
  id-token: write
  contents: read
steps:
  - uses: actions/checkout@v4
  - id: image
    uses: Lumist-Labs/github-actions/actions/ecr-build-push@v2
    with:
      aws-role-arn: ${{ vars.AWS_DEPLOY_ROLE_ARN }}
      repository: myapp
      sha: ${{ github.sha }}
      version: ${{ inputs.version }}
  - run: echo "${{ steps.image.outputs.image }} built=${{ steps.image.outputs.built }}"
```

`vars.AWS_DEPLOY_ROLE_ARN` is illustrative; use whatever variable holds the caller's role.

| Input | Required | Default | Description |
|---|---|---|---|
| `aws-role-arn` | yes | — | Role assumed via GitHub OIDC; caller needs `id-token: write` |
| `aws-region` | no | `us-east-1` | |
| `repository` | yes | — | ECR repository name, not the URI |
| `sha` | yes | — | Immutable tag; its existence decides build vs retag |
| `version` | no | `''` | Extra human-readable tag |
| `context` | no | `.` | Build context |
| `dockerfile` | no | `Dockerfile` | Relative to `context` |
| `build-args` | no | `''` | Newline-separated `KEY=VALUE`, one `--build-arg` each |
| `platforms` | no | `''` | e.g. `linux/amd64`; empty = buildx default |
| `provenance` | no | `''` | `--provenance`; set `false` for a Lambda image |
| `sbom` | no | `''` | `--sbom` |

| Output | Description |
|---|---|
| `image` | `<registry>/<repository>:<sha>`, what a deploy step takes |
| `built` | `true` if this run built and pushed, `false` if it only retagged |

Builds use `docker buildx build --pull --push` with a GitHub Actions layer cache scoped
to `repository`.
