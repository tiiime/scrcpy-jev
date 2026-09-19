import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { browserCommand, openBrowser, shouldOpenBrowser } from '../src/server/open.mjs';
import { closeServer } from '../src/server/server.mjs';
import { createStore, StudioError } from '../src/server/store.mjs';
import { avcCodecString } from '../src/server/video.mjs';
import { humanize, labelFor } from '../src/device/apps.mjs';
import { optionsForVersion } from '../src/device/scrcpy-session.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness() {
  const gates = [];
  const runner = ({ goal, emit }) => {
    const gate = deferred();
    gates.push({ goal, emit, gate });
    return gate.promise;
  };
  const store = createStore({ runner });
  return { store, gates };
}

test('a run streams events and finishes with the reported outcome', async () => {
  const { store, gates } = harness();
  const run = store.start({ goal: 'Turn on dark theme', maxSteps: 5 });
  assert.equal(run.status, 'running');
  const seen = [];
  store.subscribe(run.id, (state) => seen.push(state.events.length));
  gates[0].emit({ type: 'decision', step: 0, operation: 'TAP', latencyMs: 120 });
  gates[0].emit({ type: 'action', step: 0, operation: 'TAP', label: 'Tap Dark theme' });
  gates[0].emit({ type: 'result', outcome: 'done', steps: 1 });
  gates[0].gate.resolve('done');
  await new Promise((resolve) => setImmediate(resolve));
  const finished = store.get(run.id);
  assert.equal(finished.status, 'succeeded');
  assert.equal(finished.outcome, 'done');
  assert.equal(finished.events.length, 3);
  assert.ok(seen.length >= 3);
  assert.equal(finished.events[1].operation, 'TAP');
});

test('a second task cannot start while one owns the device', () => {
  const { store, gates } = harness();
  store.start({ goal: 'first' });
  assert.throws(() => store.start({ goal: 'second' }), StudioError);
  gates[0].gate.resolve('done');
});

test('stopping signals the runner and settles as stopped', async () => {
  const { store, gates } = harness();
  const run = store.start({ goal: 'long task' });
  const stopped = store.stop(run.id);
  assert.equal(stopped.status, 'stopping');
  gates[0].gate.resolve('cancelled');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(run.id).status, 'stopped');
});

test('a blocked outcome is not reported as success', async () => {
  const { store, gates } = harness();
  const run = store.start({ goal: 'blocked task' });
  gates[0].emit({ type: 'result', outcome: 'blocked', steps: 4 });
  gates[0].gate.resolve('blocked');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(run.id).status, 'blocked');
});

test('a runner failure is reported without losing the events', async () => {
  const store = createStore({
    runner: async ({ emit }) => {
      emit({ type: 'decision', step: 0 });
      throw new Error('device went away');
    },
  });
  const run = store.start({ goal: 'anything' });
  await new Promise((resolve) => setImmediate(resolve));
  const finished = store.get(run.id);
  assert.equal(finished.status, 'failed');
  assert.equal(finished.error, 'device went away');
  assert.equal(finished.events.length, 1);
});

test('input is validated and cleared runs are counted', async () => {
  const { store, gates } = harness();
  assert.throws(() => store.start({ goal: '   ' }), /between 1 and 4,000/);
  assert.throws(() => store.start({ goal: 'x', maxSteps: 99 }), /step limit/);
  const run = store.start({ goal: 'ok' });
  assert.throws(() => store.clear(), /Stop the active task/);
  gates[0].gate.resolve('done');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(store.clear(), { cleared: 1 });
  assert.equal(store.list().length, 0);
  assert.equal(store.get(run.id), null);
});

test('avcCodecString reads the SPS profile and level', () => {
  const sps = Buffer.from([
    0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x20, 0xac, 0xd9, 0x40, 0x00, 0x00, 0x01, 0x68, 0xee,
  ]);
  assert.equal(avcCodecString(sps), 'avc1.640020');
  assert.equal(avcCodecString(Buffer.from([1, 2, 3])), null);
});

test('app labels fall back to a readable package name', () => {
  assert.equal(labelFor('com.android.settings'), 'Settings');
  assert.equal(labelFor('com.tencent.mm'), 'WeChat');
  assert.equal(humanize('com.example.my_cool_app'), 'My Cool App');
  assert.equal(humanize('org.example.simple'), 'Simple');
});

test('the scrcpy protocol revision is mapped onto the client library', () => {
  assert.equal(optionsForVersion('3.1').name, 'AdbScrcpyOptions3_1');
  assert.equal(optionsForVersion('3.9').name, 'AdbScrcpyOptions3_3_3');
  assert.equal(optionsForVersion('2.6').name, 'AdbScrcpyOptions2_6');
  assert.equal(optionsForVersion('1.0').name, 'AdbScrcpyOptions1_15');
});

test('shutdown terminates live clients instead of waiting for them', async () => {
  const http = createServer((_request, response) => {
    // A server-sent event stream that intentionally never ends, like the studio's run feed.
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(': open\n\n');
  });
  const sockets = new WebSocketServer({ server: http });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address();

  const held = [];
  for (let index = 0; index < 2; index++) {
    const socket = net.connect(port, '127.0.0.1');
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write('GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
    held.push(socket);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));

  const started = performance.now();
  await closeServer(http, sockets, { graceMs: 400 });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1500, `closeServer took ${Math.round(elapsed)} ms`);
  assert.equal(http.listening, false);
  for (const socket of held) socket.destroy();
});

test('closeServer tolerates a server that never had clients', async () => {
  const http = createServer(() => {});
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  await closeServer(http, null, { graceMs: 200 });
  assert.equal(http.listening, false);
});

test('step records are keyed by step, merged, and cleared with their run', async () => {
  const { store, gates } = harness();
  const run = store.start({ goal: 'Inspect me' });
  gates[0].emit({ type: 'decision', step: 0, operation: 'TAP', detail: { request: { a: 1 } } });
  gates[0].emit({
    type: 'action',
    step: 0,
    operation: 'TAP',
    detail: { execution: { executed: { x: 4 } } },
  });
  gates[0].emit({ type: 'detail', step: 0, detail: { screenChanged: true } });
  gates[0].emit({ type: 'decision', step: 1, operation: 'DONE', detail: { request: { a: 2 } } });

  assert.deepEqual(store.step(run.id, 0), {
    request: { a: 1 },
    execution: { executed: { x: 4 } },
    screenChanged: true,
  });
  assert.deepEqual(store.step(run.id, 1), { request: { a: 2 } });
  assert.deepEqual(store.steps(run.id), [0, 1]);
  assert.equal(store.step(run.id, 5), null);

  // 'detail' events enrich a step but must never appear as a timeline entry.
  assert.deepEqual(
    store.get(run.id).events.map((event) => event.type),
    ['decision', 'action', 'decision'],
  );
  assert.equal(store.get(run.id).events[0].detail, undefined);

  gates[0].gate.resolve('done');
  await new Promise((resolve) => setImmediate(resolve));
  store.clear();
  assert.equal(store.step(run.id, 0), null);
  assert.deepEqual(store.steps(run.id), []);
});

test('an oversized step record is replaced by a marker instead of being kept', async () => {
  const { store, gates } = harness();
  const run = store.start({ goal: 'Huge screen' });
  gates[0].emit({
    type: 'decision',
    step: 0,
    detail: { request: { blob: 'x'.repeat(600 * 1024) } },
  });
  assert.equal(store.step(run.id, 0).truncated, true);
  assert.match(store.step(run.id, 0).reason, /exceeded/);
  gates[0].gate.resolve('done');
});

test('only the interactive entry point opens a browser', () => {
  assert.equal(shouldOpenBrowser({ mode: 'dev', env: {} }), true);
  assert.equal(shouldOpenBrowser({ mode: 'start', env: {} }), false);
  assert.equal(shouldOpenBrowser({ mode: 'start', env: { STUDIO_OPEN: '1' } }), true);
  assert.equal(shouldOpenBrowser({ mode: 'dev', env: { STUDIO_OPEN: '0' } }), false);
});

test('the studio URL is opened with the right command per platform', () => {
  const url = 'http://127.0.0.1:3050';
  assert.deepEqual(browserCommand('darwin', url), { command: 'open', args: [url] });
  assert.deepEqual(browserCommand('win32', url), {
    command: 'cmd',
    args: ['/c', 'start', '', url],
  });
  assert.deepEqual(browserCommand('linux', url), { command: 'xdg-open', args: [url] });
});

test('opening a browser never takes the server down with it', () => {
  const launched = [];
  const spawnProcess = (command, args, options) => {
    launched.push({ command, args, options });
    return { on() {}, unref() {} };
  };
  assert.equal(openBrowser('http://127.0.0.1:3050', { platform: 'darwin', spawnProcess }), true);
  assert.deepEqual(launched[0].args, ['http://127.0.0.1:3050']);
  assert.equal(launched[0].options.detached, true);

  // A missing `xdg-open` reports the failure instead of throwing.
  const failures = [];
  const result = openBrowser('http://127.0.0.1:3050', {
    platform: 'linux',
    spawnProcess: () => {
      throw new Error('spawn xdg-open ENOENT');
    },
    onError: (error) => failures.push(error.message),
  });
  assert.equal(result, false);
  assert.deepEqual(failures, ['spawn xdg-open ENOENT']);
});
