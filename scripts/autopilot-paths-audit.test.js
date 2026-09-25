'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { groups } = require('./autopilot-paths-audit.js');

test('splits on the top-level | only', () => {
  assert.deepEqual(groups('(^alembic/)|(^src/(core|runs)/)|((^|[/_.-])(o?auth|polic(y|ies))([/_.-]|$))'), [
    '(^alembic/)',
    '(^src/(core|runs)/)',
    '((^|[/_.-])(o?auth|polic(y|ies))([/_.-]|$))',
  ]);
});

test('an unwrapped alternative is still its own group', () => {
  assert.deepEqual(groups('(^|/)auth/|\\.tf$'), ['(^|/)auth/', '\\.tf$']);
});

test('a | inside a character class or escaped does not split', () => {
  assert.deepEqual(groups('[a|b]x|y\\|z'), ['[a|b]x', 'y\\|z']);
});
