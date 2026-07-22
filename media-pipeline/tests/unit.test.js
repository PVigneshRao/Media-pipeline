const test = require('node:test');
const assert = require('node:assert');
const { hammingDistance } = require('../src/utils/hamming');
const InMemoryQueue = require('../src/queue/inMemoryQueue');

test('hammingDistance: identical hashes -> 0', () => {
  assert.strictEqual(hammingDistance('a1b2c3', 'a1b2c3'), 0);
});

test('hammingDistance: single differing hex digit contributes its bit-diff count', () => {
  // 'a' = 1010, 'b' = 1011 -> differ in 1 bit
  assert.strictEqual(hammingDistance('a', 'b'), 1);
});

test('hammingDistance: mismatched lengths -> Infinity', () => {
  assert.strictEqual(hammingDistance('ab', 'abc'), Infinity);
});

test('hammingDistance: null/undefined input -> Infinity', () => {
  assert.strictEqual(hammingDistance(null, 'ab'), Infinity);
  assert.strictEqual(hammingDistance('ab', undefined), Infinity);
});

test('InMemoryQueue: respects concurrency limit', async () => {
  const queue = new InMemoryQueue({ concurrency: 2 });
  let active = 0;
  let maxActive = 0;
  let completed = 0;

  queue.process(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    completed += 1;
  });

  for (let i = 0; i < 6; i += 1) queue.enqueue({ id: i });

  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.strictEqual(completed, 6);
  assert.ok(maxActive <= 2, `expected max concurrency <= 2, got ${maxActive}`);
});

test('InMemoryQueue: a throwing handler does not stop the queue from draining', async () => {
  const queue = new InMemoryQueue({ concurrency: 1 });
  const processed = [];

  queue.process(async (job) => {
    if (job.id === 'bad') throw new Error('boom');
    processed.push(job.id);
  });

  queue.enqueue({ id: 'bad' });
  queue.enqueue({ id: 'good' });

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepStrictEqual(processed, ['good']);
});
