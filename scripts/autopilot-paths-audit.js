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

// Splits on the top-level `|` only, so a group like ((^|/)auth) stays whole.
function groups(pattern) {
  const out = [];
  let depth = 0;
  let inClass = false;
  let start = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') i++;
    else if (inClass) inClass = c !== ']';
    else if (c === '[') inClass = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '|' && depth === 0) {
      out.push(pattern.slice(start, i));
      start = i + 1;
    }
  }
  out.push(pattern.slice(start));
  return out;
}

function main() {
  const [configPath, repo, ref = 'develop'] = process.argv.slice(2);
  if (!configPath || !repo) {
    console.error('usage: autopilot-paths-audit.js <autopilot-repos.json> <owner/repo> [ref]');
    process.exit(2);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))[repo];
  if (!config) throw new Error(`${repo} is not in ${configPath}`);

  if (!config['blocked-paths']) throw new Error(`${repo} has no blocked-paths`);

  const tree = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/git/trees/${ref}?recursive=1`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }));
  if (tree.truncated) throw new Error(`GitHub truncated the ${repo} tree; the counts would be low`);
  const files = tree.tree
    .filter((e) => e.type === 'blob' && /\.(py|pyi|ex|exs|heex|eex|ts|tsx|js|jsx|mjs|sql)$/.test(e.path))
    .map((e) => e.path);


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
}

if (require.main === module) main();
module.exports = { groups };
