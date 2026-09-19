import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuestions, TypeSafePolicy, validateChoice } from '../src/agent/policy.mjs';
import { textCandidates } from '../src/agent/text.mjs';
import { candidatesFor, describeAction } from '../src/agent/actions.mjs';

function observation(overrides = {}) {
  const elements = [
    {
      id: 'w0.1',
      text: 'Search',
      label: '',
      resourceId: 'app:id/search',
      hint: '',
      bounds: { left: 0, top: 0, right: 500, bottom: 100 },
      clickable: true,
      editable: false,
      scrollable: false,
      enabled: true,
      focused: false,
      password: false,
      checkable: false,
      checked: false,
      selected: false,
    },
    {
      id: 'w0.2',
      text: 'Dark theme',
      label: 'Dark theme switch',
      resourceId: 'app:id/switch',
      hint: '',
      bounds: { left: 0, top: 120, right: 500, bottom: 200 },
      clickable: true,
      editable: false,
      scrollable: false,
      enabled: true,
      focused: false,
      password: false,
      checkable: true,
      checked: false,
      selected: false,
    },
    {
      id: 'w0.3',
      text: '',
      label: 'Query',
      resourceId: 'app:id/query',
      hint: 'Search',
      bounds: { left: 0, top: 220, right: 500, bottom: 300 },
      clickable: true,
      editable: true,
      scrollable: false,
      enabled: true,
      focused: true,
      password: false,
      checkable: false,
      checked: false,
      selected: false,
    },
    {
      id: 'w0.4',
      text: '',
      label: '',
      resourceId: 'app:id/list',
      hint: '',
      bounds: { left: 0, top: 320, right: 500, bottom: 900 },
      clickable: false,
      editable: false,
      scrollable: true,
      enabled: true,
      focused: false,
      password: false,
      checkable: false,
      checked: false,
      selected: false,
    },
  ];
  return {
    deviceId: 'serial',
    fingerprint: 'fingerprint',
    observedAt: Date.now(),
    screen: { width: 500, height: 1000, rotation: 0 },
    phone: {
      packageName: 'com.example.app',
      currentApp: 'com.example.app',
      isEditable: true,
      inputElementId: 'w0.3',
      keyboardVisible: true,
      focusEvidence: 'focused-node',
      focusedElement: { resourceId: 'app:id/query', className: 'android.widget.EditText' },
    },
    elements,
    ...overrides,
  };
}

test('textCandidates only offers spans that appear in the goal', () => {
  const { values, source } = textCandidates('Search for Golden Gate Bridge');
  assert.equal(source, 'goal');
  assert.ok(values.includes('Golden Gate Bridge'));
  assert.ok(!values.includes('Search for Golden Gate Bridge and book'));
  assert.deepEqual(textCandidates('x', ['exact value']), {
    values: ['exact value'],
    source: 'supplied',
    overflow: false,
  });
});

test('textCandidates reports overflow instead of sending a huge prompt', () => {
  const goal = Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ');
  assert.equal(textCandidates(goal).overflow, true);
});

test('candidatesFor derives scroll gestures from each scrollable region', () => {
  const candidates = candidatesFor(observation(), ['Golden Gate Bridge']);
  assert.ok(candidates['tap_w0.1']);
  assert.ok(candidates['scroll_down_w0.4']);
  assert.ok(candidates.enter);
  assert.ok(candidates.text_0);
  assert.equal(candidates.back.type, 'global');
});

test('describeAction explains an element tap with its visible labels', () => {
  const action = { type: 'tap-element', elementId: 'w0.2' };
  assert.match(describeAction(action, observation()), /Dark theme/);
});

test('buildQuestions offers only reachable operations', () => {
  const { questions } = buildQuestions(
    observation(),
    ['Golden Gate Bridge'],
    [{ label: 'Settings', packageName: 'com.android.settings' }],
  );
  const operations = Object.keys(questions.operation.criteria);
  assert.ok(operations.includes('TAP'));
  assert.ok(operations.includes('TYPE_TEXT'));
  assert.ok(operations.includes('SCROLL_DOWN'));
  assert.ok(operations.includes('OPEN_APP'));
  assert.ok(operations.includes('DONE'));
  assert.ok(operations.includes('SCROLL_LEFT'));
});

test('validateChoice rejects malformed distributions', () => {
  const criteria = { A: 'a', B: 'b' };
  const valid = { type: 'choice', choice: 'A', confidence: 0.8, probabilities: { A: 0.8, B: 0.2 } };
  assert.equal(validateChoice(valid, criteria), valid);
  assert.throws(() => validateChoice({ ...valid, probabilities: { A: 1, B: 1 } }, criteria));
  assert.throws(() => validateChoice({ ...valid, choice: 'C' }, criteria));
  assert.throws(() =>
    validateChoice({ ...valid, choice: 'B', probabilities: { A: 0.8, B: 0.2 } }, criteria),
  );
});

/** Builds a valid TypeSafe response body for the questions the policy actually sent. */
function responder({ operation, targets = {}, confidence = 0.8, overrides = {} }) {
  return async (input) => {
    const payload = typeof input.body === 'string' ? JSON.parse(input.body) : input.body;
    const answers = {};
    for (const [name, question] of Object.entries(payload.questions)) {
      if (overrides[name]) {
        answers[name] = overrides[name];
        continue;
      }
      const ids = Object.keys(question.criteria);
      const choice = name === 'operation' ? operation : targets[name];
      if (choice === undefined) continue;
      const others = ids.filter((id) => id !== choice);
      const probabilities = { [choice]: others.length ? confidence : 1 };
      for (const id of others)
        probabilities[id] = (1 - (others.length ? confidence : 1)) / others.length;
      answers[name] = { type: 'choice', choice, confidence, probabilities };
    }
    return Buffer.from(JSON.stringify({ model: 'jev-test', answers }));
  };
}

test('the policy turns a choice into an executable action', async () => {
  const requests = [];
  const policy = new TypeSafePolicy({
    apiKey: 'test-key',
    request: async (input) => {
      requests.push(input);
      return responder({ operation: 'TAP', targets: { tap_target: '2' } })(input);
    },
  });
  const decision = await policy.decide({ goal: 'Turn on dark theme', observation: observation() });
  assert.equal(decision.status, 'action');
  assert.equal(decision.operation, 'TAP');
  assert.deepEqual(decision.action, { type: 'tap-element', elementId: 'w0.2' });
  assert.equal(decision.responseModel, 'jev-test');
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /systemone$/);
  const payload =
    typeof requests[0].body === 'string' ? JSON.parse(requests[0].body) : requests[0].body;
  assert.equal(payload.state.goal, 'Turn on dark theme');
  assert.ok(payload.state.elements.length >= 4);
});

test('an unused speculative target cannot execute', async () => {
  const policy = new TypeSafePolicy({
    apiKey: 'test-key',
    request: responder({
      operation: 'DONE',
      overrides: {
        // Structurally invalid, but irrelevant because the operation is DONE.
        tap_target: { type: 'choice', choice: '99', confidence: 1, probabilities: { 99: 1 } },
      },
    }),
  });
  const decision = await policy.decide({ goal: 'Anything', observation: observation() });
  assert.equal(decision.status, 'done');
  assert.equal(decision.action, undefined);
});

test('a confidence threshold turns a low-confidence choice into an uncertain stop', async () => {
  const policy = new TypeSafePolicy({
    apiKey: 'test-key',
    threshold: 0.9,
    request: responder({ operation: 'WAIT', confidence: 0.5 }),
  });
  const decision = await policy.decide({ goal: 'Anything', observation: observation() });
  assert.equal(decision.status, 'uncertain');
});

test('missing text for a focused field asks the operator for a value', async () => {
  const policy = new TypeSafePolicy({
    apiKey: 'test-key',
    request: responder({ operation: 'TYPE_TEXT', targets: { text_value: 'NONE' } }),
  });
  const decision = await policy.decide({ goal: 'Search', observation: observation() });
  assert.equal(decision.status, 'needs_input');
  assert.match(decision.reason, /--text/);
});

test('a supplied text span becomes a clearing type action', async () => {
  const policy = new TypeSafePolicy({
    apiKey: 'test-key',
    request: responder({ operation: 'TYPE_TEXT', targets: { text_value: '1' } }),
  });
  const decision = await policy.decide({
    goal: 'Search for Golden Gate Bridge',
    observation: observation(),
  });
  assert.equal(decision.status, 'action');
  assert.equal(decision.action.type, 'type');
  assert.equal(decision.action.clear, true);
  assert.ok(decision.action.text.length > 0);
});

test('scrolling resolves to the offered region gesture', async () => {
  const policy = new TypeSafePolicy({
    apiKey: 'test-key',
    request: responder({ operation: 'SCROLL_DOWN', targets: { scroll_target: '4' } }),
  });
  const decision = await policy.decide({ goal: 'Find the switch', observation: observation() });
  assert.equal(decision.status, 'action');
  assert.equal(decision.action.type, 'swipe');
  assert.equal(decision.action.regionId, 'w0.4');
  assert.ok(decision.action.startY > decision.action.endY);
});

test('the policy refuses an oversized screen payload', async () => {
  const policy = new TypeSafePolicy({
    apiKey: 'test-key',
    request: responder({ operation: 'WAIT' }),
  });
  const big = observation();
  big.elements = Array.from({ length: 4000 }, (_, index) => ({
    ...big.elements[0],
    id: `w0.${index}`,
    text: `Element ${index} ${'x'.repeat(40)}`,
  }));
  await assert.rejects(() => policy.decide({ goal: 'Anything', observation: big }), /too large/);
});
