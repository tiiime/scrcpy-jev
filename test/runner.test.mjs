// Covers the wiring between the studio's run store and the agent loop. The store hands the runner a
// single-argument `emit(event)`; passing `emit(type, data)` silently drops every event and every run
// ends as "The task ended unexpectedly." with an empty timeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/agent.mjs';
import { createStudioRunner } from '../src/server/runner.mjs';
import { createStore } from '../src/server/store.mjs';

function observation(fingerprint, overrides = {}) {
  return {
    deviceId: 'serial',
    fingerprint,
    observedAt: Date.now(),
    screen: { width: 500, height: 1000, rotation: 0 },
    phone: {
      packageName: 'com.example.app',
      currentApp: 'com.example.app',
      isEditable: false,
      inputElementId: undefined,
      keyboardVisible: false,
      focusEvidence: 'none',
      focusedElement: { resourceId: '', className: '' },
    },
    elements: [],
    ...overrides,
  };
}

function fakeDevice() {
  let index = 0;
  const frames = [observation('a'), observation('b'), observation('c'), observation('d')];
  return {
    calls: [],
    async assertReady() {
      return { id: 'serial', state: 'ready' };
    },
    async observe() {
      return frames[Math.min(index++, frames.length - 1)];
    },
    async listApps() {
      return [{ packageName: 'com.android.settings', label: 'Settings' }];
    },
    async act(action, options) {
      this.calls.push({ action, options });
      // The real adapter returns a receipt describing what was actually sent.
      return { executed: { ...action } };
    },
  };
}

function scriptedPolicy(decisions) {
  let index = 0;
  return {
    async decide() {
      return decisions[Math.min(index++, decisions.length - 1)];
    },
  };
}

test('the studio runner forwards every agent event into the run record', async () => {
  const device = fakeDevice();
  const policy = scriptedPolicy([
    {
      status: 'action',
      operation: 'HOME',
      action: { type: 'global', name: 'home' },
      label: 'Return to the home screen',
      confidence: 0.91,
      latencyMs: 143.5,
      responseModel: 'jev-test',
    },
    {
      status: 'done',
      operation: 'DONE',
      confidence: 0.97,
      latencyMs: 90,
      responseModel: 'jev-test',
    },
  ]);
  const runner = createStudioRunner({ device, policy });
  const store = createStore({ runner });

  const started = store.start({ goal: 'Go home', maxSteps: 5 });
  assert.equal(started.status, 'running');

  await new Promise((resolve) => setTimeout(resolve, 60));
  const run = store.get(started.id);
  assert.equal(run.status, 'succeeded', run.error || '');
  assert.equal(run.outcome, 'done');
  assert.equal(run.error, null);

  const types = run.events.map((event) => event.type);
  assert.deepEqual(types, ['decision', 'action', 'decision', 'result']);
  assert.equal(run.events[0].operation, 'HOME');
  assert.equal(run.events[0].model, 'jev-test');
  assert.equal(run.events[0].latencyMs, 143.5);
  assert.equal(run.events[1].label, 'Return to the home screen');
  assert.equal(run.events[3].outcome, 'done');
  assert.ok(run.events[3].timings.wallMs >= 0);
  assert.deepEqual(
    run.events.map((event) => event.sequence),
    [0, 1, 2, 3],
  );

  // The real agent loop, not a stub: the action must have reached the device.
  assert.equal(device.calls.length, 1);
  assert.deepEqual(device.calls[0].action, { type: 'global', name: 'home' });
});

test('each step keeps its full model exchange out of the event feed', async () => {
  const device = fakeDevice();
  const request = { model: 'jev-test', state: { goal: 'Go home' }, questions: { operation: {} } };
  const response = { model: 'jev-test', answers: { operation: { choice: 'HOME' } } };
  let call = 0;
  const policy = {
    async decide() {
      if (call++ > 0)
        return {
          status: 'done',
          operation: 'DONE',
          confidence: 0.9,
          latencyMs: 5,
          responseModel: 'jev-test',
        };
      return {
        status: 'action',
        operation: 'HOME',
        action: { type: 'global', name: 'home' },
        label: 'Return to the home screen',
        confidence: 0.9,
        latencyMs: 12,
        responseModel: 'jev-test',
        request,
        response,
      };
    },
  };
  const store = createStore({ runner: createStudioRunner({ device, policy }) });
  const started = store.start({ goal: 'Go home', maxSteps: 2 });
  await new Promise((resolve) => setTimeout(resolve, 80));

  // The timeline entry stays small: no request/response payload leaks into the event feed.
  const run = store.get(started.id);
  const decision = run.events.find((event) => event.type === 'decision');
  for (const leaked of ['request', 'response', 'detail'])
    assert.ok(!(leaked in decision), `${leaked} must not reach the event feed`);
  assert.ok(JSON.stringify(run).length < 4000, 'the run snapshot stays small');

  // The full exchange is available on demand, merged per step.
  const record = store.step(started.id, 0);
  assert.deepEqual(record.request, request);
  assert.deepEqual(record.response, response);
  assert.equal(record.decision.operation, 'HOME');
  assert.equal(record.execution.action.type, 'global');
  assert.equal(record.execution.executed.name, 'home');
  assert.equal(record.before.packageName, 'com.example.app');
  assert.equal(record.after.packageName, 'com.example.app');
  assert.equal(typeof record.screenChanged, 'boolean');
  assert.ok(store.steps(started.id).includes(0));
  assert.equal(store.step(started.id, 99), null);
  // The result record lives under 'final', keyed the same way the API path is.
  assert.equal(store.step(started.id, 'final').outcome, 'done');
});

test('a blocked outcome is recorded with its events intact', async () => {
  const device = fakeDevice();
  const policy = scriptedPolicy([
    {
      status: 'blocked',
      operation: 'BLOCKED',
      confidence: 0.8,
      reason: 'No offered operation can progress.',
      latencyMs: 120,
      responseModel: 'jev-test',
    },
  ]);
  const store = createStore({ runner: createStudioRunner({ device, policy }) });
  const started = store.start({ goal: 'Impossible', maxSteps: 3 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const run = store.get(started.id);
  assert.equal(run.status, 'blocked');
  assert.equal(run.outcome, 'blocked');
  assert.deepEqual(
    run.events.map((event) => event.type),
    ['decision', 'result'],
  );
  assert.match(run.events[1].reason, /No offered operation/);
});

test('a failing agent loop is reported with its message and keeps earlier events', async () => {
  const device = fakeDevice();
  const failing = async ({ onStep }) => {
    onStep({ step: 0, status: 'action', operation: 'TAP', label: 'Tap', latencyMs: 10 });
    throw new Error('Model API returned HTTP 401.');
  };
  const store = createStore({
    runner: createStudioRunner({ device, policy: scriptedPolicy([]), run: failing }),
  });
  const started = store.start({ goal: 'Anything', maxSteps: 3 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const run = store.get(started.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'Model API returned HTTP 401.');
  assert.deepEqual(
    run.events.map((event) => event.type),
    ['decision'],
  );
});

test('an operator stop during a run settles as stopped', async () => {
  const device = fakeDevice();
  const policy = scriptedPolicy([
    {
      status: 'action',
      operation: 'HOME',
      action: { type: 'global', name: 'home' },
      label: 'Return to the home screen',
      confidence: 0.9,
      latencyMs: 10,
      responseModel: 'jev-test',
    },
  ]);
  const store = createStore({ runner: createStudioRunner({ device, policy, run: runAgent }) });
  const started = store.start({ goal: 'Never finishes', maxSteps: 50 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  store.stop(started.id);
  // The loop can be inside its brief post-action settle window before it notices the stop.
  await new Promise((resolve) => setTimeout(resolve, 800));
  const run = store.get(started.id);
  assert.equal(run.status, 'stopped');
  assert.ok(run.events.some((event) => event.type === 'action'));
});
