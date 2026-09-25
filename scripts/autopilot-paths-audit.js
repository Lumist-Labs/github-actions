#!/usr/bin/env node
'use strict';

// Shows what a repo's Autopilot path patterns actually match, so a change to
// blocked-paths or sensitive-paths is reviewed as a list of files, not a regex.
//
//   node autopilot-paths-audit.js <autopilot-repos.json> <owner/repo> [ref]
//
// Reads the tree with `gh api`. Counts code files only: a pattern that hits a
// README costs nothing, one that hits half of lib/ blocks most issues.

const fs = require('fs');
const { execFileSync } = require('child_process');

const [configPath, repo, ref = 'develop'] = process.argv.slice(2);
if (!configPath || !repo) {
  console.error('usage: autopilot-paths-audit.js <autopilot-repos.json> <owner/repo> [ref]');
  process.exit(2);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))[repo];
if (!config) throw new Error(`${repo} is not in ${configPath}`);

const tree = execFileSync('gh', ['api', `repos/${repo}/git/trees/${ref}?recursive=1`, '--jq', '.tree[]|select(.type=="blob")|.path'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const files = tree.split('\n').filter((f) => /\.(py|pyi|ex|exs|heex|eex|ts|tsx|js|jsx|mjs|sql)$/.test(f));

// Top-level groups only, which is how the config writes them: (a)|(b)|(c).
const groups = (pattern) => pattern.match(/\((?:[^()]|\([^()]*\))*\)/g) ?? [pattern];

const blocked = new RegExp(config['blocked-paths'], 'i');
const tiers = [
  ['blocked', config['blocked-paths'], () => true],
  ['sensitive', config['sensitive-paths'], (f) => !blocked.test(f)],
];

console.log(`${repo}@${ref}: ${files.length} code files`);
for (const [tier, pattern, eligible] of tiers) {
  if (!pattern) continue;
  const all = new RegExp(pattern, 'i');
  const hit = files.filter((f) => eligible(f) && all.test(f));
  console.log(`\n${tier}: ${hit.length} files (${((100 * hit.length) / files.length).toFixed(1)}%)`);
  for (const group of groups(pattern)) {
    const re = new RegExp(group, 'i');
    const matched = hit.filter((f) => re.test(f));
    console.log(`\n  ${group}  ${matched.length}`);
    matched.forEach((f) => console.log(`    ${f}`));
  }
}
