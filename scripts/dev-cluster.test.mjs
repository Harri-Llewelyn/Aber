// =================================================================================================
// scripts/dev-cluster.mjs: how a port-forward that does not open says why
//
// forwardReady() against stand-ins for kubectl (node children that write what kubectl writes), and
// forwardOnFreePort()'s second attempt, taken only when the port was taken. The forwards themselves
// need a cluster: `npm run dev:test` and the rehearsals run them.
// =================================================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { forwardOnFreePort, forwardReady } from './dev-cluster.mjs';

/** A node child standing in for kubectl, running `code`, with both outputs piped as the forwards pipe them. */
function standIn(code) {
  return spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}
const READY = "process.stdout.write('Forwarding from 127.0.0.1:1 -> 443\\n'); setInterval(() => {}, 1000)";
const SILENT = 'setInterval(() => {}, 1000)';
const exitsWith = (status, lines) => `process.stderr.write(${JSON.stringify(lines.join('\n'))} + '\\n'); process.exit(${status})`;

test('a forward that opens resolves ok', async () => {
  const child = standIn(READY);
  try {
    assert.deepEqual(await forwardReady(child, 5000), { ok: true });
  } finally {
    child.kill();
  }
});

test('kubectl exiting is named with its code and the last lines of its stderr', async () => {
  const lines = ['line 1', 'line 2', 'line 3', 'E1024 lost connection to pod',
    'error: unable to forward port because pod is not running. Current status=Pending', 'line 6', 'line 7'];
  const ready = await forwardReady(standIn(exitsWith(3, lines)), 5000);
  assert.equal(ready.ok, false);
  assert.match(ready.reason, /^kubectl exited with code 3\. Its stderr ended:\n/);
  for (const line of lines.slice(-5)) assert.ok(ready.reason.includes(`    ${line}`), `missing "${line}"`);
  assert.ok(!ready.reason.includes('line 2'), 'only the last lines are quoted');
  assert.equal(ready.portTaken, false);
});

test('kubectl exiting silently says its stderr was empty', async () => {
  const ready = await forwardReady(standIn('process.exit(1)'), 5000);
  assert.equal(ready.reason, "kubectl exited with code 1; kubectl's stderr was empty");
});

test('no "Forwarding from" in time is named with the wait, and an empty stderr says so', async () => {
  const child = standIn(SILENT);
  try {
    const ready = await forwardReady(child, 300);
    assert.equal(ready.ok, false);
    assert.equal(ready.reason, `no "Forwarding from" after 0.3 s; kubectl's stderr was empty`);
  } finally {
    child.kill();
  }
});

test('no "Forwarding from" in time quotes whatever stderr had arrived', async () => {
  const child = standIn("process.stderr.write('W1024 the API server is slow to answer\\n'); setInterval(() => {}, 1000)");
  try {
    const ready = await forwardReady(child, 1500);
    assert.equal(ready.reason, 'no "Forwarding from" after 1.5 s. kubectl\'s stderr so far:\n    W1024 the API server is slow to answer');
  } finally {
    child.kill();
  }
});

// What kubectl prints when it cannot bind the local port, on Linux and on Windows.
const TAKEN_LINUX = ['Unable to listen on port 41234: Listeners failed to create with the following errors: [unable to create listener: Error listen tcp4 127.0.0.1:41234: bind: address already in use]',
  'error: unable to listen on any of the requested ports: [{41234 443}]'];
const TAKEN_WINDOWS = ['unable to create listener: Error listen tcp4 127.0.0.1:41234: bind: Only one usage of each socket address (protocol/network address/port) is normally permitted.',
  'error: unable to listen on any of the requested ports: [{41234 443}]'];

test('a port another socket holds is told apart from every other failure', async () => {
  for (const lines of [TAKEN_LINUX, TAKEN_WINDOWS]) {
    const ready = await forwardReady(standIn(exitsWith(1, lines)), 5000);
    assert.equal(ready.portTaken, true, lines[0]);
  }
});

test('a taken port is tried once more, on another port from freePort()', async () => {
  const ports = [];
  const children = [];
  const forward = await forwardOnFreePort((port) => {
    ports.push(port);
    const child = standIn(ports.length === 1 ? exitsWith(1, TAKEN_LINUX) : READY);
    children.push(child);
    return child;
  }, 5000);
  try {
    assert.equal(forward.ok, true);
    assert.equal(ports.length, 2);
    assert.equal(forward.port, ports[1]);
    assert.equal(forward.child, children[1]);
  } finally {
    children.forEach((child) => child.kill());
  }
});

test('a port taken twice fails with the second reason, after two attempts only', async () => {
  let calls = 0;
  const forward = await forwardOnFreePort(() => { calls++; return standIn(exitsWith(1, TAKEN_LINUX)); }, 5000);
  assert.equal(calls, 2);
  assert.equal(forward.ok, false);
  assert.match(forward.reason, /^kubectl exited with code 1\. Its stderr ended:\n.*address already in use/s);
});

test('a Service with no ready pod, or a forward that never opens, fails on the first attempt', async () => {
  let calls = 0;
  const gone = await forwardOnFreePort(() => {
    calls++;
    return standIn(exitsWith(1, ['error: unable to forward port because pod is not running. Current status=Pending']));
  }, 5000);
  assert.equal(calls, 1);
  assert.match(gone.reason, /pod is not running/);

  const children = [];
  const silent = await forwardOnFreePort(() => { const child = standIn(SILENT); children.push(child); return child; }, 300);
  children.forEach((child) => child.kill());
  assert.equal(children.length, 1);
  assert.match(silent.reason, /^no "Forwarding from" after 0\.3 s/);
});
