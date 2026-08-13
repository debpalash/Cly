'use strict';

// Pure helpers from the sync loop. These are the parts where a mistake shows up
// as a duplicated or missing message in a thread rather than as an exception.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Sync } = require('../src/sync');

test('an exact repeat of a narration item is not said twice', () => {
  const seen = new Set(['assistant:I will start with the sync loop.']);
  assert.equal(
    Sync.alreadySaid(seen, { kind: 'assistant', text: 'I will start with the sync loop.' }),
    true,
  );
});

// The capture window scrolls, so a long message loses its opening lines and
// comes back as a shorter block. That is the same message, not a new one.
test('the tail of a message already posted is not posted again', () => {
  const full =
    'I will check each file in turn.\n\nFirst, a.txt: counting the words in its sentence about the sea.';
  const seen = new Set([`assistant:${full}`]);
  assert.equal(
    Sync.alreadySaid(seen, {
      kind: 'assistant',
      text: 'First, a.txt: counting the words in its sentence about the sea.',
    }),
    true,
  );
});

test('a genuinely new thought still gets through', () => {
  const seen = new Set(['assistant:I will check each file in turn.']);
  assert.equal(
    Sync.alreadySaid(seen, { kind: 'assistant', text: 'b.txt has 11 words.' }),
    false,
  );
});

// Tool labels are short and repeat verbatim ("Read 1 file"), so containment
// would collapse unrelated ones. They are matched exactly and nothing else.
test('tool labels are matched exactly, never by containment', () => {
  const seen = new Set(['assistant:Read 1 file and then some more of them']);
  assert.equal(Sync.alreadySaid(seen, { kind: 'tool', text: 'Read 1 file' }), false);
  seen.add('tool:Read 1 file');
  assert.equal(Sync.alreadySaid(seen, { kind: 'tool', text: 'Read 1 file' }), true);
});

test('delta emits only what is new in an overlapping window', () => {
  assert.deepEqual(Sync.delta(['a', 'b', 'c'], ['b', 'c', 'd']), ['d']);
  assert.deepEqual(Sync.delta([], ['a']), ['a']);
  // No overlap at all: the agent scrolled further than one window between
  // reads, so everything in the new window is new to us.
  assert.deepEqual(Sync.delta(['a'], ['x', 'y']), ['x', 'y']);
});

// The last item in a capture is either half-written or — when somebody in the
// thread is waiting on an answer — the answer itself, which #postAnswer posts
// as a reply to their message. Narrating it too would say it twice.
test('the newest item is withheld while the agent is still writing', () => {
  const items = [
    { kind: 'assistant', text: 'Starting on the sync loop now.', last: false },
    { kind: 'tool', text: 'Read 1 file', last: false },
    { kind: 'assistant', text: 'Here is what I found in the end.', last: true },
  ];
  const held = Sync.freshNarration(items, new Set(), true);
  assert.deepEqual(
    held.map((i) => i.text),
    ['Starting on the sync loop now.', 'Read 1 file'],
  );

  // Once it is settled and nobody is waiting on a reply, it goes out.
  const all = Sync.freshNarration(items, new Set(), false);
  assert.equal(all.length, 3);
});

test('a withheld item is still available on the next pass', () => {
  const items = [
    { kind: 'assistant', text: 'One.', last: false },
    { kind: 'assistant', text: 'Two, the final word.', last: true },
  ];
  const seen = new Set();
  assert.deepEqual(Sync.freshNarration(items, seen, true).map((i) => i.text), ['One.']);
  assert.deepEqual(
    Sync.freshNarration(items, seen, false).map((i) => i.text),
    ['Two, the final word.'],
  );
});

// The prompt is already in the thread as the message that was typed.
test('the human turn is recorded but never posted back', () => {
  const seen = new Set();
  const fresh = Sync.freshNarration(
    [
      { kind: 'user', text: 'count the words in each file', last: false },
      { kind: 'assistant', text: 'Counting them now.', last: false },
    ],
    seen,
    false,
  );
  assert.deepEqual(fresh.map((i) => i.text), ['Counting them now.']);
  assert.ok(seen.has('user:count the words in each file'));
});
