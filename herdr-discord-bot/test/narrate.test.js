'use strict';

// narrate() feeds the mid-run commentary in an agent's thread. extractAnswer
// answers "what did it conclude"; this answers "what is it doing right now",
// which is the question you actually have while watching from a phone.

const test = require('node:test');
const assert = require('node:assert/strict');
const { narrate } = require('../src/answer');

const CLAUDE_RUN = [
  '● Let me look at the sync loop first.',
  '● Read(src/sync.js)',
  '  ⎿  Read 100 lines',
  '● Edit(src/sync.js)',
  '  ⎿  Updated 2 additions',
  '● The rename was blocking the tick, so I routed it through renameLater.',
  '✻ Cooked for 12s',
  '❯',
  'esc to interrupt · 1.2k tokens',
].join('\n');

test('reports prose and tool calls in the order they happened', () => {
  const { items } = narrate(CLAUDE_RUN, { agent: 'claude' });
  assert.deepEqual(
    items.map((i) => `${i.kind}:${i.text}`),
    [
      'assistant:Let me look at the sync loop first.',
      'tool:Read(src/sync.js)',
      'tool:Edit(src/sync.js)',
      'assistant:The rename was blocking the tick, so I routed it through renameLater.',
    ],
  );
});

// Only the last item can still be half-written, so it is the only one a live
// caller has to hold back.
test('flags the newest item so a live caller can hold it back', () => {
  const { items } = narrate(CLAUDE_RUN, { agent: 'claude' });
  assert.equal(items.filter((i) => i.last).length, 1);
  assert.equal(items[items.length - 1].last, true);
});

test('a tool card contributes its title, never its output', () => {
  const { items } = narrate(CLAUDE_RUN, { agent: 'claude' });
  const joined = items.map((i) => i.text).join('\n');
  assert.ok(!joined.includes('Read 100 lines'));
  assert.ok(!joined.includes('Updated 2 additions'));
});

test('reads a codex transcript too', () => {
  const terminal = [
    '• Ran git status --short',
    '  │ ?? answer.js',
    '  └ completed in 30ms',
    '• Implemented answer extraction.',
    '─ Worked for 5s ─────',
  ].join('\n');

  const { items, profile } = narrate(terminal, { agent: 'codex' });
  assert.equal(profile, 'codex');
  assert.deepEqual(
    items.map((i) => `${i.kind}:${i.text}`),
    ['tool:Ran git status --short', 'assistant:Implemented answer extraction.'],
  );
});

test('an unreadable capture narrates nothing rather than guessing', () => {
  assert.deepEqual(narrate('', { agent: 'claude' }).items, []);
  assert.deepEqual(narrate('{"error":"pane not found"}', { agent: 'claude' }).items, []);
});

// A long tool title would otherwise push the rolling activity line over
// Discord's message limit on its own.
test('a very long tool title is clamped', () => {
  const terminal = ['● Bash(' + 'x'.repeat(300) + ')', '  ⎿  ok'].join('\n');
  const { items } = narrate(terminal, { agent: 'claude' });
  assert.equal(items.length, 1);
  assert.ok(items[0].text.length <= 90);
  assert.ok(items[0].text.endsWith('…'));
});

// A capture window that starts mid-message has lost the marker that said who
// was speaking. In practice that is usually the tail of the human's own prompt,
// wrapped and indented exactly like a reply — posting it back into the thread
// as if the agent had said it is worse than saying nothing.
test('an unmarked opening fragment is not attributed to the agent', () => {
  const terminal = [
    '  what you are about to do, then write f.txt with a sentence about deserts;',
    '  then read both back and count the words in each.',
    '● First, I am about to create f.txt with a sentence about deserts.',
    '  Read 1 file',
    '✻ Cooked for 3s',
  ].join('\n');

  const { items } = narrate(terminal, { agent: 'claude' });
  assert.deepEqual(
    items.map((i) => `${i.kind}:${i.text}`),
    ['assistant:First, I am about to create f.txt with a sentence about deserts.', 'tool:Read 1 file'],
  );
});
