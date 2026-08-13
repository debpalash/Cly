'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Queue, MAX_PER_AGENT } = require('../src/queue');

// Stands in for the real store: same two methods, kept in memory.
function fakeStore(initial = {}) {
  const meta = { ...initial };
  return {
    getMeta: (k) => meta[k],
    setMeta: (k, v) => {
      meta[k] = v;
    },
    _meta: meta,
  };
}

test('prompts come back out in the order they were typed', () => {
  const q = new Queue({ store: fakeStore() });
  assert.equal(q.push('w1:p1', { text: 'first' }), 1);
  assert.equal(q.push('w1:p1', { text: 'second' }), 2);
  assert.equal(q.shift('w1:p1').text, 'first');
  assert.equal(q.shift('w1:p1').text, 'second');
  assert.equal(q.shift('w1:p1'), null);
});

test('each agent has its own line', () => {
  const q = new Queue({ store: fakeStore() });
  q.push('w1:p1', { text: 'for one' });
  q.push('w2:p1', { text: 'for two' });
  assert.equal(q.size('w1:p1'), 1);
  assert.equal(q.shift('w2:p1').text, 'for two');
  assert.equal(q.size('w1:p1'), 1);
});

// What you typed before a restart is still what you want said afterwards.
test('a queue survives being reloaded from the store', () => {
  const store = fakeStore();
  const first = new Queue({ store });
  first.push('w1:p1', { text: 'remember me', messageId: '42' });

  const second = new Queue({ store });
  assert.equal(second.size('w1:p1'), 1);
  const back = second.shift('w1:p1');
  assert.equal(back.text, 'remember me');
  assert.equal(back.messageId, '42');
});

test('an emptied queue leaves nothing behind in the store', () => {
  const store = fakeStore();
  const q = new Queue({ store });
  q.push('w1:p1', { text: 'x' });
  q.shift('w1:p1');
  assert.deepEqual(store._meta.promptQueue, {});
});

test('the queue refuses to grow without bound', () => {
  const q = new Queue({ store: fakeStore() });
  for (let i = 0; i < MAX_PER_AGENT; i += 1) q.push('w1:p1', { text: `p${i}` });
  assert.throws(() => q.push('w1:p1', { text: 'one too many' }), /full/);
});

test('a corrupt saved queue is ignored rather than fatal', () => {
  const q = new Queue({ store: fakeStore({ promptQueue: { 'w1:p1': 'not an array' } }) });
  assert.equal(q.size('w1:p1'), 0);
});
