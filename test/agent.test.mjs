import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/agent.mjs';
import { StaleObservationError } from '../src/device/device.mjs';

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

function fakeDevice({ observations, act }) {
  let index = 0;
  return {
    calls: [],
    async assertReady() {
      return { id: 'serial', state: 'ready' };
    },
    async observe() {
      const value = observations[Math.min(index, observations.length - 1)];
      index++;
      return value;
    },
    async listApps() {
      return [];
    },
    async act(action, options) {
      this.calls.push({ action, options });
      return act ? act(action, options, this.calls.length) : undefined;
    },
  };
}

const step = (action, label = 'do it') => ({
  status: 'action',
  operation: action.type === 'global' ? action.name.toUpperCase() : 'TAP',
  action,
  label,
  confidence: 0.9,
});

function scriptedPolicy(decisions) {
  let index = 0;
  return {
    calls: 0,
    async decide() {
      this.calls++;
      return decisions[Math.min(index++, decisions.length - 1)];
    },
  };
}

test('a DONE decision ends the run without touching the device', async () => {
  const device = fakeDevice({ observations: [observation('a')] });
  const policy = scriptedPolicy([{ status: 'done', operation: 'DONE', confidence: 0.9 }]);
  const result = await runAgent({ device, policy, goal: 'anything', execute: true });
  assert.equal(result.status, 'done');
  assert.equal(device.calls.length, 0);
});

test('preview mode stops before executing the selected action', async () => {
  const device = fakeDevice({ observations: [observation('a')] });
  const policy = scriptedPolicy([step({ type: 'global', name: 'home' })]);
  const result = await runAgent({ device, policy, goal: 'anything' });
  assert.equal(result.status, 'preview');
  assert.equal(device.calls.length, 0);
  assert.equal(result.decision.operation, 'HOME');
});

test('actions are executed, recorded and observed in order', async () => {
  const device = fakeDevice({
    observations: [observation('a'), observation('b'), observation('c')],
  });
  const policy = scriptedPolicy([
    step({ type: 'global', name: 'home' }),
    step({ type: 'global', name: 'back' }),
    { status: 'done', operation: 'DONE', confidence: 0.9 },
  ]);
  const actions = [];
  const result = await runAgent({
    device,
    policy,
    goal: 'anything',
    execute: true,
    onAction: (event) => actions.push(event.operation),
  });
  assert.equal(result.status, 'done');
  assert.deepEqual(actions, ['HOME', 'BACK']);
  assert.equal(device.calls.length, 2);
  assert.ok(result.timings.modelCalls >= 3);
});

test('a stale decision is discarded and re-decided without executing input', async () => {
  const device = fakeDevice({
    observations: [observation('a'), observation('b'), observation('c')],
    act(_action, _options, call) {
      if (call === 1) throw new StaleObservationError('moved');
    },
  });
  const policy = scriptedPolicy([
    step({ type: 'global', name: 'back' }),
    step({ type: 'global', name: 'home' }),
    { status: 'done', operation: 'DONE', confidence: 0.9 },
  ]);
  const result = await runAgent({ device, policy, goal: 'anything', execute: true });
  assert.equal(result.status, 'done');
  assert.equal(result.timings.staleRetries, 1);
  assert.equal(device.calls.length, 2);
});

test('three consecutive stale screens stop as unstable', async () => {
  const device = fakeDevice({
    observations: Array.from({ length: 8 }, (_, index) => observation(`f${index}`)),
    act() {
      throw new StaleObservationError('moved');
    },
  });
  const policy = scriptedPolicy([step({ type: 'global', name: 'back' })]);
  const result = await runAgent({ device, policy, goal: 'anything', execute: true });
  assert.equal(result.status, 'unstable_screen');
  assert.equal(result.timings.staleRetries, 3);
});

test('repeating the same action on the same screen stops as stuck', async () => {
  const device = fakeDevice({ observations: [observation('same'), observation('same')] });
  const policy = scriptedPolicy([step({ type: 'global', name: 'back' })]);
  const result = await runAgent({ device, policy, goal: 'anything', execute: true });
  assert.equal(result.status, 'stuck');
  assert.equal(device.calls.length, 1);
});

test('the step limit is enforced before a further action is executed', async () => {
  const device = fakeDevice({
    observations: Array.from({ length: 10 }, (_, index) => observation(`f${index}`)),
  });
  const policy = scriptedPolicy([step({ type: 'global', name: 'back' })]);
  const result = await runAgent({ device, policy, goal: 'anything', execute: true, maxSteps: 2 });
  assert.equal(result.status, 'step_limit');
  assert.equal(device.calls.length, 2);
});

test('an unverified text value stops the run instead of retyping', async () => {
  const focused = observation('typed', {
    phone: {
      packageName: 'com.example.app',
      currentApp: 'com.example.app',
      isEditable: true,
      inputElementId: 'field',
      keyboardVisible: true,
      focusEvidence: 'focused-node',
      focusedElement: { resourceId: '', className: '' },
    },
    elements: [
      {
        id: 'field',
        text: '',
        label: '',
        resourceId: 'app:id/field',
        hint: '',
        bounds: { left: 0, top: 0, right: 100, bottom: 50 },
        clickable: true,
        editable: true,
        scrollable: false,
        enabled: true,
        focused: true,
        password: false,
      },
    ],
  });
  const device = fakeDevice({
    observations: [focused, focused, focused, focused],
    act() {
      return {
        inputVerification: {
          deviceId: 'serial',
          packageName: 'com.example.app',
          target: {
            id: 'field',
            resourceId: 'app:id/field',
            hint: '',
            bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          },
          text: 'Golden Gate Bridge',
        },
      };
    },
  });
  const policy = scriptedPolicy([
    {
      status: 'action',
      operation: 'TYPE_TEXT',
      action: { type: 'type', text: 'Golden Gate Bridge', clear: true },
      label: 'Type "Golden Gate Bridge"',
      confidence: 0.9,
    },
  ]);
  const result = await runAgent({
    device,
    policy,
    goal: 'Search for Golden Gate Bridge',
    execute: true,
    inputTimeoutMs: 120,
  });
  assert.equal(result.status, 'input_unverified');
  assert.match(result.decision.reason, /could not be confirmed/);
  assert.equal(device.calls.length, 1);
});

test('an operator stop aborts before the next decision', async () => {
  const device = fakeDevice({ observations: [observation('a')] });
  const policy = scriptedPolicy([step({ type: 'global', name: 'back' })]);
  await assert.rejects(
    () =>
      runAgent({
        device,
        policy,
        goal: 'anything',
        execute: true,
        shouldStop: () => true,
      }),
    /stopped by the operator/,
  );
  assert.equal(policy.calls, 0);
});

test('arguments are validated', async () => {
  const device = fakeDevice({ observations: [observation('a')] });
  const policy = scriptedPolicy([{ status: 'done' }]);
  await assert.rejects(() => runAgent({ device, policy, goal: 'x', maxSteps: 0 }), /maxSteps/);
  await assert.rejects(
    () => runAgent({ device, policy, goal: 'x', waitTimeoutMs: 999_999 }),
    /waitTimeoutMs/,
  );
});
