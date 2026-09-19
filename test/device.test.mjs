import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeState } from '../src/device/summarize.mjs';
import { ScrcpyDevice, StaleObservationError, assertFresh } from '../src/device/device.mjs';

function dump(overrides = {}) {
  return {
    ok: true,
    screen: { width: 1000, height: 2000, rotation: 0 },
    packageName: 'com.example.app',
    isEditable: false,
    focusedEditable: false,
    keyboardVisible: false,
    nodes: [
      {
        path: 'w0',
        depth: 0,
        text: '',
        label: '',
        hint: '',
        resourceId: '',
        package: 'com.example.app',
        className: 'android.widget.FrameLayout',
        bounds: [0, 0, 1000, 2000],
        clickable: false,
        editable: false,
        scrollable: false,
        enabled: true,
        focused: false,
        visible: true,
        password: false,
        checkable: false,
        checked: false,
        selected: false,
      },
      {
        path: 'w0.0',
        depth: 1,
        text: 'Sign in',
        label: '',
        hint: '',
        resourceId: 'com.example.app:id/title',
        package: 'com.example.app',
        className: 'android.widget.TextView',
        bounds: [40, 100, 400, 160],
        clickable: false,
        editable: false,
        scrollable: false,
        enabled: true,
        focused: false,
        visible: true,
        password: false,
        checkable: false,
        checked: false,
        selected: false,
      },
      {
        path: 'w0.1',
        depth: 1,
        text: '',
        label: 'null',
        hint: 'Email',
        resourceId: 'com.example.app:id/email',
        package: 'com.example.app',
        className: 'android.widget.EditText',
        bounds: [40, 200, 960, 280],
        clickable: true,
        editable: true,
        scrollable: false,
        enabled: true,
        focused: false,
        visible: true,
        password: false,
        checkable: false,
        checked: false,
        selected: false,
      },
      {
        path: 'w0.2',
        depth: 1,
        text: 'secret',
        label: '',
        hint: '',
        resourceId: 'com.example.app:id/password',
        package: 'com.example.app',
        className: 'android.widget.EditText',
        bounds: [40, 300, 960, 380],
        clickable: true,
        editable: true,
        scrollable: false,
        enabled: true,
        focused: true,
        visible: true,
        password: true,
        checkable: false,
        checked: false,
        selected: false,
      },
      {
        path: 'w0.3',
        depth: 1,
        text: '',
        label: '',
        hint: '',
        resourceId: '',
        package: 'com.example.app',
        className: 'android.view.View',
        bounds: [0, 0, 0, 0],
        clickable: true,
        editable: false,
        scrollable: false,
        enabled: true,
        focused: false,
        visible: true,
        password: false,
        checkable: false,
        checked: false,
        selected: false,
      },
    ],
    ...overrides,
  };
}

test('summarizeState keeps labelled, actionable elements and drops empty boxes', () => {
  const observation = summarizeState(dump(), 'serial-1');
  assert.equal(observation.deviceId, 'serial-1');
  assert.deepEqual(observation.screen, { width: 1000, height: 2000, rotation: 0 });
  assert.equal(observation.phone.packageName, 'com.example.app');
  assert.deepEqual(
    observation.elements.map((element) => element.id),
    ['w0.0', 'w0.1', 'w0.2'],
  );
  // "null" is a platform quirk, not a label.
  assert.equal(observation.elements[1].label, '');
  assert.equal(observation.elements[1].hint, 'Email');
});

test('summarizeState redacts passwords and reports the focused field', () => {
  const observation = summarizeState(dump(), 'serial-1');
  const password = observation.elements.find((element) => element.resourceId.endsWith('password'));
  assert.equal(password.text, '[password]');
  assert.equal(password.label, '');
  assert.equal(observation.phone.isEditable, true);
  assert.equal(observation.phone.inputElementId, 'w0.2');
  assert.equal(observation.phone.focusEvidence, 'focused-node');
});

test('a single field with the keyboard up counts as focused', () => {
  const raw = dump({ keyboardVisible: true, focusedEditable: false });
  raw.nodes = raw.nodes.filter((node) => node.path !== 'w0.2');
  const observation = summarizeState(raw, 'serial-1');
  assert.equal(observation.phone.inputElementId, 'w0.1');
  assert.equal(observation.phone.focusEvidence, 'single-input-with-keyboard');
});

test('summarizeState rejects a dump without bounds', () => {
  assert.throws(() => summarizeState({ nodes: [] }, 'serial-1'), /missing its element tree/);
});

test('the fingerprint ignores the observation time', () => {
  const first = summarizeState(dump(), 'serial-1');
  const second = summarizeState(dump(), 'serial-1');
  second.observedAt += 5000;
  assert.equal(first.fingerprint, second.fingerprint);
});

test('assertFresh accepts an unchanged screen but rejects a changed label', () => {
  const expected = summarizeState(dump(), 'serial-1');
  const unchanged = summarizeState(dump(), 'serial-1');
  assert.doesNotThrow(() =>
    assertFresh(unchanged, expected, { type: 'tap-element', elementId: 'w0.0' }),
  );
  // Bounds drift is tolerated: the tap is re-resolved from the current tree. Labels are not.
  const shifted = dump();
  shifted.nodes[1].bounds = [40, 120, 400, 180];
  assert.doesNotThrow(() =>
    assertFresh(summarizeState(shifted, 'serial-1'), expected, {
      type: 'tap-element',
      elementId: 'w0.0',
    }),
  );
  const relabelled = dump();
  relabelled.nodes[1].text = 'Signed in as Wario';
  assert.throws(
    () =>
      assertFresh(summarizeState(relabelled, 'serial-1'), expected, {
        type: 'tap-element',
        elementId: 'w0.0',
      }),
    StaleObservationError,
  );
});

test('assertFresh rejects an expired observation and a different device', () => {
  const expected = summarizeState(dump(), 'serial-1');
  expected.observedAt = Date.now() - 60_000;
  assert.throws(
    () => assertFresh(summarizeState(dump(), 'serial-1'), expected, { type: 'tap', x: 1, y: 2 }),
    StaleObservationError,
  );
  const fresh = summarizeState(dump(), 'serial-1');
  const other = summarizeState(dump(), 'serial-2');
  assert.throws(
    () => assertFresh(other, fresh, { type: 'tap', x: 1, y: 2 }),
    StaleObservationError,
  );
});

test('HOME stays valid across unrelated screen changes', () => {
  const expected = summarizeState(dump(), 'serial-1');
  const changed = dump();
  changed.nodes[1].text = 'A clock that ticks';
  assert.doesNotThrow(() =>
    assertFresh(summarizeState(changed, 'serial-1'), expected, { type: 'global', name: 'home' }),
  );
});

test('element taps refuse an element that is no longer actionable', async () => {
  const observation = summarizeState(dump(), 'serial-1');
  const device = new ScrcpyDevice({
    adb: null,
    helper: { dump: async () => dump() },
    session: null,
    device: { serial: 'serial-1', model: 'Test' },
  });
  device.readyAt = performance.now();
  await assert.rejects(
    () => device.act({ type: 'tap-element', elementId: 'w0.0' }, { expected: observation }),
    /not actionable/,
  );
});

test('a broken helper connection is repaired once, without retrying mutations', async () => {
  const observation = summarizeState(dump(), 'serial-1');
  let calls = 0;
  const device = new ScrcpyDevice({
    adb: null,
    helper: {
      async dump() {
        calls++;
        throw new Error('This socket has been ended by the other party');
      },
    },
    session: null,
    device: { serial: 'serial-1', model: 'Test' },
    refreshHelper: async () => ({
      async dump() {
        calls++;
        return dump();
      },
    }),
  });
  const result = await device.observe();
  assert.equal(calls, 2, 'the first read fails, the retry succeeds');
  assert.equal(result.phone.packageName, observation.phone.packageName);

  // Without a refresh hook the error surfaces instead of being hidden.
  const broken = new ScrcpyDevice({
    adb: null,
    helper: {
      async dump() {
        throw new Error('gone');
      },
    },
    session: null,
    device: { serial: 'serial-1', model: 'Test' },
  });
  await assert.rejects(() => broken.observe(), /gone/);
});
