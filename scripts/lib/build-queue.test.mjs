// =================================================================================================
// scripts/lib/build-queue.mjs: the order of `dev-cluster up`'s image builds
//
// The queue against stand-in builds that each wait on a promise the test settles, so which build is
// running when is decided here and not by a timer. The builds themselves need docker: `npm run
// dev:up`, CI's k8s-validation job and the rehearsals run them.
// =================================================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_BUILD_JOBS, buildJobs, runQueue } from './build-queue.mjs';

/**
 * Stand-in builds: `start` records the task as running and waits until the test calls
 * `finish(name, ok)`. `settle()` lets the queue react to the builds finished so far.
 */
function standIns() {
  const running = new Set();
  const started = [];
  const waiting = new Map();
  let most = 0;
  const start = (task) => new Promise((resolve) => {
    running.add(task.name);
    started.push(task.name);
    most = Math.max(most, running.size);
    waiting.set(task.name, (ok) => { running.delete(task.name); resolve({ ok }); });
  });
  const finish = (name, ok = true) => {
    assert.ok(waiting.has(name), `${name} is not running`);
    const done = waiting.get(name);
    waiting.delete(name);
    done(ok);
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { start, finish, settle, running, started, most: () => most };
}

const tasks = (...names) => names.map((name) => (typeof name === 'string' ? { name } : name));

test('ABER_BUILD_JOBS: unset or empty is the default of 4, a positive integer is itself', () => {
  assert.equal(DEFAULT_BUILD_JOBS, 4);
  assert.equal(buildJobs(undefined), 4);
  assert.equal(buildJobs(''), 4);
  assert.equal(buildJobs('1'), 1);
  assert.equal(buildJobs('12'), 12);
  assert.equal(buildJobs(' 3 '), 3);
});

test('ABER_BUILD_JOBS: anything else throws, naming the variable and the value', () => {
  for (const bad of ['0', '-2', '2.5', 'four', '1e2', '08', '3 4']) {
    assert.throws(() => buildJobs(bad), (e) => e.message.includes('ABER_BUILD_JOBS') && e.message.includes(JSON.stringify(bad)), bad);
  }
});

test('the cap is never exceeded, and is used', async () => {
  const s = standIns();
  const queue = runQueue(tasks('a', 'b', 'c', 'd', 'e', 'f', 'g'), 3, s.start);
  await s.settle();
  assert.deepEqual(s.started, ['a', 'b', 'c']);
  // Finished out of order: each end starts exactly one more, in list order.
  for (const [name, next] of [['b', 'd'], ['a', 'e'], ['d', 'f'], ['c', 'g']]) {
    s.finish(name);
    await s.settle();
    assert.equal(s.started.at(-1), next);
    assert.ok(s.running.size <= 3);
  }
  for (const name of [...s.running]) s.finish(name);
  const { failed, notStarted, results } = await queue;
  assert.equal(s.most(), 3);
  assert.deepEqual(failed, []);
  assert.deepEqual(notStarted, []);
  assert.equal(results.size, 7);
});

test('one at a time builds in list order, each after the last has ended', async () => {
  const s = standIns();
  const queue = runQueue(tasks('a', 'b', 'c'), 1, s.start);
  for (const name of ['a', 'b', 'c']) {
    await s.settle();
    assert.deepEqual([...s.running], [name]);
    s.finish(name);
  }
  await queue;
  assert.deepEqual(s.started, ['a', 'b', 'c']);
  assert.equal(s.most(), 1);
});

test('an image starts only after the one it is `after` has built, and does not hold up the rest', async () => {
  const s = standIns();
  const queue = runQueue(tasks('a', { name: 'b', after: 'a' }, 'c', 'd'), 2, s.start);
  await s.settle();
  assert.deepEqual(s.started, ['a', 'c']);
  s.finish('c');
  await s.settle();
  // b is next in the list but waits on a; d takes the free slot.
  assert.deepEqual(s.started, ['a', 'c', 'd']);
  s.finish('d');
  await s.settle();
  assert.deepEqual([...s.running], ['a']);
  s.finish('a');
  await s.settle();
  assert.deepEqual(s.started, ['a', 'c', 'd', 'b']);
  s.finish('b');
  assert.deepEqual((await queue).failed, []);
});

test('an `after` naming an image not being built counts as built (--only=test-runner)', async () => {
  const s = standIns();
  const queue = runQueue(tasks({ name: 'test-runner', after: 'ingestion' }), 4, s.start);
  await s.settle();
  assert.deepEqual(s.started, ['test-runner']);
  s.finish('test-runner');
  assert.deepEqual((await queue).failed, []);
});

test('a failure starts nothing new, and the builds already running finish', async () => {
  const s = standIns();
  let resolved = false;
  const queue = runQueue(tasks('a', 'b', 'c', 'd'), 2, s.start).then((r) => { resolved = true; return r; });
  await s.settle();
  s.finish('a', false);
  await s.settle();
  assert.deepEqual(s.started, ['a', 'b'], 'nothing starts after the failure');
  assert.equal(resolved, false, 'the queue waits for b');
  s.finish('b');
  const { failed, notStarted, results } = await queue;
  assert.deepEqual(failed, ['a']);
  assert.deepEqual(notStarted, ['c', 'd']);
  assert.equal(results.get('b').ok, true);
});

test('every failure among the running builds is reported', async () => {
  const s = standIns();
  const queue = runQueue(tasks('a', 'b', 'c'), 3, s.start);
  await s.settle();
  s.finish('b', false);
  s.finish('c', false);
  s.finish('a');
  const { failed, notStarted } = await queue;
  assert.deepEqual(failed.sort(), ['b', 'c']);
  assert.deepEqual(notStarted, []);
});

test('an image after one that failed is never started', async () => {
  const s = standIns();
  const queue = runQueue(tasks('a', { name: 'b', after: 'a' }), 4, s.start);
  await s.settle();
  s.finish('a', false);
  const { failed, notStarted } = await queue;
  assert.deepEqual(failed, ['a']);
  assert.deepEqual(notStarted, ['b']);
  assert.deepEqual(s.started, ['a']);
});

test('a build that throws or rejects is a failure, with the error kept', async () => {
  const boom = new Error('docker is not on PATH');
  const { failed, results } = await runQueue(tasks('a', 'b'), 1, (task) => {
    if (task.name === 'a') throw boom;
    return Promise.resolve({ ok: true });
  });
  assert.deepEqual(failed, ['a']);
  assert.equal(results.get('a').error, boom);
  assert.equal(results.has('b'), false);
});

test('a cycle of `after`s throws rather than hanging', async () => {
  await assert.rejects(
    runQueue(tasks({ name: 'a', after: 'b' }, { name: 'b', after: 'a' }), 2, () => ({ ok: true })),
    /never start: a \(after b\), b \(after a\)/,
  );
});

test('a cap that is not a positive integer throws', async () => {
  await assert.rejects(runQueue(tasks('a'), 0, () => ({ ok: true })), /positive integer/);
});
