# Autopilot's build container for LumiLearn and Vector (Elixir): the repo's own CI image plus Node 22,
# which Claude Code and the workflow's gh install need. Built on the CI image so
# the toolchain matches what the repo's CI runs.
FROM node:22-slim AS node

FROM ghcr.io/lumist-labs/ci-elixir:1.19.5-otp-28

# libstdc++ because the node binary links it and the slim bases don't ship it.
RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends libstdc++6 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && node --version && npm --version
