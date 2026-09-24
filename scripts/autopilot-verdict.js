#!/usr/bin/env node
'use strict';

// Parses the scoring model's output and decides, for real, whether autopilot may
// proceed. Called by .github/workflows/claude-issue-autopilot.yml.
//
//   node autopilot-verdict.js <raw-output> <verdict-json-out> <comment-md-out>
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
// Three outcomes: `work` runs now, `offer` waits for a Beacon admin, `review`
// goes to a human. Anything that makes the change unsafe or unauthorized is a
// hard stop and always `review`; only size and confidence can land on `offer`.
//
// OVERRIDE=true is a Beacon admin's trigger. It waives size, confidence and the
// model's own `review`, never a stop that makes the change unsafe.
//
// Reads from env: MAX_POINTS, OFFER_MAX_POINTS, BLOCKED_PATHS, BRANCH_PREFIXES,
// OVERRIDE, ISSUE, GITHUB_OUTPUT.

const fs = require('fs');

const [rawPath, verdictPath, commentPath] = process.argv.slice(2);
const maxPoints = Number(process.env.MAX_POINTS || 2);
const offerMaxPoints = Number(process.env.OFFER_MAX_POINTS || 3);
const blocked = new RegExp(process.env.BLOCKED_PATHS || '(^alembic/)', 'i');
const prefixes = (process.env.BRANCH_PREFIXES || 'feat|fix').split('|');
const issue = process.env.ISSUE || '0';
const override = process.env.OVERRIDE === 'true';

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

// Exact scale values only: Number(null), Number('') and Number(false) are all 0, which clears every threshold.
const validPoints = [1, 2, 3, 5, 8, 13].includes(parsed.points);
const points = validPoints ? parsed.points : 99;
const files = Array.isArray(parsed.files) ? parsed.files.filter((f) => typeof f === 'string') : [];
const acceptance = Array.isArray(parsed.acceptance) ? parsed.acceptance.filter((a) => typeof a === 'string') : [];
const branch = typeof parsed.branch === 'string' ? parsed.branch.trim() : '';
const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
const blockedReason = typeof parsed.blocked_reason === 'string' ? parsed.blocked_reason.trim() : '';
// Missing or unrecognised reads as low, so a model that drops the field fails closed.
const confidence = ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low';

// Collected rather than returned early, so the comment can list every one that
// fired. `unsafe` is always review. `judged` is review unless an admin
// overrides. `soft` alone is an offer.
const unsafe = [];
const judged = [];
const soft = [];

if (parseError) {
  unsafe.push(`the scoring pass did not return usable JSON (${parseError})`);
}
if (parsed.decision !== 'work' && !blockedReason) {
  judged.push(reason || 'the scoring pass chose developer review');
}
if (!parseError && !validPoints) {
  unsafe.push(`points ${JSON.stringify(parsed.points)} is not on the 1/2/3/5/8/13 scale`);
} else if (points > offerMaxPoints) {
  judged.push(`scored ${points} points, above the ${offerMaxPoints}-point offer threshold`);
} else if (points > maxPoints) {
  soft.push(`scored ${points} points, above the ${maxPoints}-point autopilot threshold`);
}
if (confidence === 'low') {
  judged.push('the scoring pass reported low confidence');
} else if (confidence === 'medium') {
  soft.push('the scoring pass reported medium confidence');
}
if (blockedReason) {
  unsafe.push(`flagged as permanently unsuitable: ${blockedReason}`);
}

const hits = files.filter((f) => blocked.test(f));
if (hits.length) {
  unsafe.push(`touches protected paths — ${hits.join(', ')}`);
}

if (!files.length) {
  unsafe.push('the scoring pass named no files, so nothing was actually authorized');
}
if (!acceptance.length) {
  unsafe.push('no acceptance criteria, so there is no definition of done to implement against');
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
  unsafe.push(`branch "${branch || '(none)'}" is not one of ${prefixes.map((p) => p + "/…").join(", ")}, which would leave the PR without CI checks`);
} else if (!new RegExp(`^[a-z]+/${issue}-[a-z0-9]+(-[a-z0-9]+)*$`).test(branch)) {
  unsafe.push(`branch "${JSON.stringify(branch)}" is not \`${prefix}/${issue}-lowercase-kebab\`, which the repeat-run guard relies on`);
}

let decision;
if (unsafe.length) decision = 'review';
else if (override) decision = 'work';
else if (judged.length) decision = 'review';
else decision = soft.length ? 'offer' : 'work';
const objections = override && !unsafe.length ? [] : [...unsafe, ...judged, ...soft];
const waived = override && !unsafe.length ? [...judged, ...soft] : [];

fs.writeFileSync(
  verdictPath,
  JSON.stringify({ decision, override, points, confidence, branch, files, acceptance, reason, objections, waived }, null, 2)
);

const DECISION_TEXT = {
  work: 'implement it — a draft PR is on the way',
  offer: 'offered — waiting for a Beacon admin to start it',
  review: 'developer review',
};

// Model-written text goes into the visible comment too, where a stray `<!--`
// would open an HTML comment and hide everything after it.
const visible = (text) => text.replace(/<!--/g, '<!\u200b--').replace(/-->/g, '--\u200b>');

const md = [];
// Hidden marker carrying the score as JSON. The work job finds its brief by
// the marker, and Beacon stores the score from it. `--` is escaped so nothing
// in a reason can close the HTML comment early.
const scoreData = JSON.stringify({ decision, points: validPoints ? points : null, confidence, reason, objections, waived })
  .replace(/--/g, '-\\u002d');
md.push(`<!-- autopilot-verdict ${scoreData} -->`);
md.push('### Autopilot score');
md.push('');
md.push('| | |');
md.push('|---|---|');
md.push(`| **Points** | ${validPoints ? points : '—'} |`);
md.push(`| **Confidence** | ${parseError ? '—' : confidence} |`);
md.push(`| **Threshold** | ≤ ${maxPoints} automatic, ≤ ${offerMaxPoints} on offer |`);
md.push(`| **Decision** | ${DECISION_TEXT[decision]} |`);
if (decision === 'work') md.push(`| **Branch** | \`${branch}\` |`);
md.push('');
if (reason) {
  md.push(visible(reason));
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
  md.push('**Why this needs a developer:**');
  md.push('');
  objections.forEach((o) => md.push(`- ${visible(o)}`));
  md.push('');
  md.push(override
    ? 'Nothing has been changed. An admin trigger cannot waive these; fix the issue or work it by hand.'
    : 'Nothing has been changed. If you disagree, fix the issue body and trigger autopilot again.');
} else if (decision === 'offer') {
  md.push('**Why this is offered rather than automatic:**');
  md.push('');
  objections.forEach((o) => md.push(`- ${visible(o)}`));
  md.push('');
  md.push('Nothing protected is in scope. Nothing has been changed; a Beacon admin can start it.');
} else {
  if (override) {
    md.push(waived.length ? '**Started by a Beacon admin, waiving:**' : '**Started by a Beacon admin.**');
    md.push('');
    waived.forEach((o) => md.push(`- ${visible(o)}`));
    if (waived.length) md.push('');
  }
  md.push('The pull request will be opened as a **draft** with no local verification — CI on it is the first real check.');
}
fs.writeFileSync(commentPath, md.join('\n') + '\n');

// The run page shows this, so a green run still says what Autopilot decided.
if (process.env.GITHUB_STEP_SUMMARY) {
  const summary = [
    `### Autopilot: ${DECISION_TEXT[decision]}`,
    '',
    `${validPoints ? points + ' points' : 'no valid score'}, ${confidence} confidence`,
    '',
    ...objections.map((o) => `- ${o}`),
  ];
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
}

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `decision=${decision}\npoints=${points}\nbranch=${decision === 'work' ? branch : ''}\n`
  );
}

console.log(`decision=${decision} points=${points} branch=${branch || '(none)'}`);
if (objections.length) console.log(objections.map((o) => `  - ${o}`).join('\n'));
