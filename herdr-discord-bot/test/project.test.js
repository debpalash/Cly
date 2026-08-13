'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { observeStart } = require('../src/project');

// Reads the given frames in order, repeating the last one forever.
function frames(list) {
  let i = 0;
  return async () => list[Math.min(i++, list.length - 1)];
}

const FAST = { waitMs: 3000, stepMs: 5 };

test('a dev server that announces its URL counts as serving', async () => {
  const seen = await observeStart(
    frames([
      'ubuntu@nvidia:~/app$ bun run dev',
      ['$ vite', '', '  VITE ready in 300 ms', '  ➜  Local:   http://localhost:3069/'].join('\n'),
    ]),
    FAST,
  );
  assert.equal(seen.state, 'serving');
  assert.equal(seen.port, 3069);
});

// The case that made this necessary: astro refuses to start, and prints the
// URL of the server that is already running. Treating that as success would
// report a dead pane as a live one.
test('a failed launcher is not called serving just because it printed a URL', async () => {
  const dead = [
    'ubuntu@nvidia:~/github/palash.dev$ bun run dev',
    '$ rm -rf node_modules/.vite && astro dev',
    'Another astro dev server is already running.',
    '',
    '  URL:  http://localhost:4321',
    '  PID:  866840',
    '',
    'error: script "dev" exited with code 1',
    'ubuntu@nvidia:~/github/palash.dev$',
  ].join('\n');
  const seen = await observeStart(frames([dead, dead]), FAST);
  assert.equal(seen.state, 'failed');
});

test('a command that simply finishes is reported as exited, not failed', async () => {
  const done = ['ubuntu@nvidia:~/app$ make build', 'built 12 targets', 'ubuntu@nvidia:~/app$'].join(
    '\n',
  );
  const seen = await observeStart(frames([done, done]), FAST);
  assert.equal(seen.state, 'exited');
});

// A shell that has not echoed the command yet looks exactly like one that has
// already finished, so the first read must never decide the outcome.
test('an idle prompt on the first read does not end the watch early', async () => {
  const seen = await observeStart(
    frames([
      'ubuntu@nvidia:~/app$',
      'ubuntu@nvidia:~/app$ bun run dev',
      '  ➜  Local:   http://127.0.0.1:3900/',
    ]),
    FAST,
  );
  assert.equal(seen.state, 'serving');
  assert.equal(seen.port, 3900);
});

test('a server still booting when the watch ends is reported as running', async () => {
  const seen = await observeStart(frames(['compiling…']), { waitMs: 40, stepMs: 5 });
  assert.equal(seen.state, 'running');
});
