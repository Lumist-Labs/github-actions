#!/usr/bin/env node
'use strict';

// Parses the scoring model's output and decides, for real, whether autowork may
// proceed. Called by .github/workflows/claude-issue-autowork.yml.
//
//   node autowork-verdict.js <raw-output> <verdict-json-out> <comment-md-out>
//
// Node rather than jq because jq is not guaranteed on the self-hosted runner and
// node is installed for Claude Code anyway.
//
// THIS FILE IS THE GUARDRAIL, not the prompt. Everything here re-derives the
// decision from the model's own reported file list and overrules it on any
// mismatch. The model can only ever make the verdict *more* restrictive by
// saying `review`; it can never talk its way past a blocked path, an unknown
// branch prefix, or the point threshold.
//
// Reads from env: MAX_POINTS, BLOCKED_PATHS, BRANCH_PREFIXES, ISSUE,
// GITHUB_OUTPUT.

const fs = require('fs');

const [rawPath, verdictPath, commentPath] = process.argv.slice(2);
const maxPoints = Number(process.env.MAX_POINTS || 2);
const blocked = new RegExp(process.env.BLOCKED_PATHS || '(^alembic/)', 'i');
const prefixes = (process.env.BRANCH_PREFIXES || 'feat|fix').split('|');
const issue = process.env.ISSUE || '0';

// The prompt says "JSON and nothing else", and models mostly comply. Mostly is
// not a parser: pull the outermost brace-delimited span and ignore any prose or
// code fence around it.
function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('no JSON object found in the scoring output');
  }
  return JSON.parse(text.slice(start, end + 1));
}

let parsed;
let parseError = null;
try {
  parsed = extractJson(fs.readFileSync(rawPath, 'utf8'));
} catch (err) {
  parseError = err.message;
  parsed = {};
}

const points = Number.isFinite(Number(parsed.points)) ? Number(parsed.points) : 99;
const files = Array.isArray(parsed.files) ? parsed.files.filter((f) => typeof f === 'string') : [];
const acceptance = Array.isArray(parsed.acceptance) ? parsed.acceptance.filter((a) => typeof a === 'string') : [];
const branch = typeof parsed.branch === 'string' ? parsed.branch.trim() : '';
const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
const blockedReason = typeof parsed.blocked_reason === 'string' ? parsed.blocked_reason.trim() : '';

// Every reason the decision can be `review`, collected so the comment can say
// which one fired rather than just "no".
const objections = [];

if (parseError) {
  objections.push(`the scoring pass did not return usable JSON (${parseError})`);
}
if (parsed.decision !== 'work' && !blockedReason) {
  objections.push(reason || 'the scoring pass chose human review');
}
if (points > maxPoints) {
  objections.push(`scored ${points} points, above the ${maxPoints}-point autowork threshold`);
}
if (blockedReason) {
  objections.push(`flagged as permanently unsuitable: ${blockedReason}`);
}

const hits = files.filter((f) => blocked.test(f));
if (hits.length) {
  objections.push(`touches protected paths — ${hits.join(', ')}`);
}

if (!files.length) {
  objections.push('the scoring pass named no files, so nothing was actually authorized');
}
if (!acceptance.length) {
  objections.push('no acceptance criteria, so there is no definition of done to implement against');
}

// A branch prefix outside the consumer's CI filter produces a PR with no checks
// at all, and nothing about that failure is visible — so an unknown prefix is a
// hard stop, not a silent rewrite.
//
// The whole name is matched, not just its start: `branch` is written to
// GITHUB_OUTPUT below, and a model-supplied newline would let it append its own
// `decision=work` after ours and win.
const prefix = branch.split('/')[0];
if (!branch.includes('/') || !prefixes.includes(prefix)) {
  objections.push(`branch "${branch || '(none)'}" is not one of ${prefixes.map((p) => p + "/…").join(", ")}, which would leave the PR without CI checks`);
} else if (!new RegExp(`^[a-z]+/${issue}-[a-z0-9]+(-[a-z0-9]+)*$`).test(branch)) {
  objections.push(`branch "${JSON.stringify(branch)}" is not \`${prefix}/${issue}-lowercase-kebab\`, which the repeat-run guard relies on`);
}

const decision = objections.length ? 'review' : 'work';

fs.writeFileSync(
  verdictPath,
  JSON.stringify({ decision, points, branch, files, acceptance, reason, objections }, null, 2)
);

const md = [];
// Marker the work job greps for when it re-reads this comment as its brief.
md.push('<!-- autowork-verdict -->');
md.push('### Autowork score');
md.push('');
md.push('| | |');
md.push('|---|---|');
md.push(`| **Points** | ${parseError ? '—' : points} |`);
md.push(`| **Threshold** | ≤ ${maxPoints} |`);
md.push(`| **Decision** | ${decision === 'work' ? 'implement it — a draft PR is on the way' : 'human review'} |`);
if (decision === 'work') md.push(`| **Branch** | \`${branch}\` |`);
md.push('');
if (reason) {
  md.push(reason);
  md.push('');
}
if (files.length) {
  md.push('**Files in scope:**');
  md.push('');
  files.forEach((f) => md.push(`- \`${f}\``));
  md.push('');
}
if (acceptance.length) {
  md.push('**Done when:**');
  md.push('');
  acceptance.forEach((a) => md.push(`- ${a}`));
  md.push('');
}
if (decision === 'review') {
  md.push('**Why this needs a person:**');
  md.push('');
  objections.forEach((o) => md.push(`- ${o}`));
  md.push('');
  md.push(`Nothing has been changed. If you disagree, fix the issue body and re-apply the \`autowork\` label.`);
} else {
  md.push('The pull request will be opened as a **draft** with no local verification — CI on it is the first real check.');
}
fs.writeFileSync(commentPath, md.join('\n') + '\n');

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `decision=${decision}\npoints=${points}\nbranch=${decision === 'work' ? branch : ''}\n`
  );
}

console.log(`decision=${decision} points=${points} branch=${branch || '(none)'}`);
if (objections.length) console.log(objections.map((o) => `  - ${o}`).join('\n'));
