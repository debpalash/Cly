'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractAnswer, stripAnsi } = require('../src/answer');

test('extracts the newest completed Claude reply and ignores a tool card', () => {
  const terminal = [
    '● Earlier reply that should not be selected.',
    '✻ Cooked for 2s',
    '● Read(src/sync.js)',
    '  ⎿  Read 100 lines',
    '● Shipped the Discord reply path.',
    '  ',
    '  - Keeps the raw terminal transcript',
    '  - Replies with the final prose only',
    '✻ Cooked for 12s',
    '❯',
    'esc to interrupt · 1.2k tokens',
  ].join('\n');

  assert.deepEqual(extractAnswer(terminal, { agent: 'claude' }), {
    answer: 'Shipped the Discord reply path.\n\n- Keeps the raw terminal transcript\n- Replies with the final prose only',
    confidence: 'high',
    kind: 'prose',
  });
});

test('extracts a completed Codex reply while dropping tool-card output', () => {
  const terminal = [
    '• Ran git status --short',
    '  │ ?? answer.js',
    '  └ completed in 30ms',
    '• Implemented answer extraction.',
    '  ',
    '  The final reply now preserves Markdown.',
    '─ Worked for 5s ─────',
  ].join('\n');

  assert.deepEqual(extractAnswer(terminal, { agent: 'codex' }), {
    answer: 'Implemented answer extraction.\n\nThe final reply now preserves Markdown.',
    confidence: 'high',
    kind: 'prose',
  });
});

test('does not call a live, unfinished terminal frame a final answer', () => {
  const terminal = [
    '● I have identified the failing test and am applying the fix.',
    '❯',
    'esc to interrupt · 1.2k tokens',
  ].join('\n');

  const result = extractAnswer(terminal, { agent: 'claude' });
  assert.equal(result.answer, 'I have identified the failing test and am applying the fix.');
  assert.equal(result.confidence, 'low');
  assert.equal(result.kind, 'prose');
});

test('strips ANSI and invisible terminal characters without damaging text', () => {
  assert.equal(stripAnsi('\u001b[32mDone\u001b[0m\u200b'), 'Done');
});
