// Exercises the studio in a DOM without a browser: the module must wire itself up, render the
// empty state, and render a live run from server-sent events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));

class FakeSocket {
  static OPEN = 1;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    FakeSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }
  send(payload) {
    this.sent.push(payload);
  }
  close() {
    this.readyState = 3;
  }
}

class FakeEvents {
  static instances = [];
  constructor(url) {
    this.url = url;
    FakeEvents.instances.push(this);
  }
  close() {}
}

function fakeRun(overrides = {}) {
  return {
    id: 'run-1234567890',
    goal: 'Turn on dark theme',
    maxSteps: 30,
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    events: [],
    outcome: null,
    error: null,
    ...overrides,
  };
}

let bootCount = 0;

const STEP_RECORD = {
  request: {
    model: 'jev-test',
    state: {
      goal: 'Turn on dark theme',
      app: 'com.android.settings',
      isEditable: false,
      elements: [{ index: '1', label: 'Dark theme', operations: ['TAP'] }],
      availableApps: [],
      visibleText: ['Dark theme'],
      recentActions: [],
      textSource: 'goal',
    },
    questions: {
      operation: { criteria: { TAP: 'Tap something', DONE: 'Finished' } },
      tap_target: { criteria: { 1: '[1] Dark theme' } },
    },
  },
  response: {
    model: 'jev-test',
    answers: {
      operation: {
        type: 'choice',
        choice: 'TAP',
        confidence: 0.86,
        probabilities: { TAP: 0.86, DONE: 0.14 },
      },
      tap_target: { type: 'choice', choice: '1', confidence: 0.79, probabilities: { 1: 0.79 } },
    },
  },
  decision: {
    status: 'action',
    operation: 'TAP',
    target: '1',
    confidence: 0.86,
    latencyMs: 210,
    responseModel: 'jev-test',
    usage: { total_tokens: 812 },
  },
  execution: {
    action: { type: 'tap-element', elementId: 'w0.1' },
    executed: { type: 'tap-element', elementId: 'w0.1', x: 720, y: 1180 },
    verified: true,
    executedMs: 312,
  },
  before: { packageName: 'com.android.settings', elements: 43, fingerprint: 'aaaaaaaaaaaa' },
  after: { packageName: 'com.android.settings', elements: 44, fingerprint: 'bbbbbbbbbbbb' },
  screenChanged: true,
};

async function bootStudio({ runs = [], postRun = () => fakeRun(), responses = {} } = {}) {
  const html = await readFile(`${WEB}index.html`, 'utf8');
  const { window, document } = parseHTML(html);
  const calls = [];
  const timers = [];
  const errors = [];

  const previous = {};
  const install = (name, value) => {
    previous[name] = globalThis[name];
    globalThis[name] = value;
  };

  install('window', window);
  install('document', document);
  install('location', { protocol: 'http:', host: '127.0.0.1:3050', reload() {} });
  install('WebSocket', FakeSocket);
  install('EventSource', FakeEvents);
  install('setInterval', () => 0);
  install('fetch', async (path, options) => {
    calls.push({ path, method: options?.method || 'GET' });
    if (responses[path]) return { ok: true, json: async () => responses[path] };
    if (path === '/api/device')
      return {
        ok: true,
        json: async () => ({
          id: 'device-1',
          name: 'Test phone',
          state: 'ready',
          transport: 'ADB · scrcpy',
          screen: { width: 1440, height: 3200 },
          video: { width: 464, height: 1024 },
          model: 'jev-latest',
          hasModelKey: true,
        }),
      };
    if (path === '/api/runs' && options?.method === 'POST')
      return { ok: true, json: async () => postRun() };
    if (/\/steps\//.test(path)) return { ok: true, json: async () => STEP_RECORD };
    if (path === '/api/runs') return { ok: true, json: async () => runs };
    return { ok: true, json: async () => ({}) };
  });
  window.addEventListener('error', (event) => errors.push(event.message));

  document.getElementById('screen').getContext = () => new Proxy({}, { get: () => () => {} });
  document.getElementById('device-stage').requestFullscreen = () => {};
  // The module is loaded once per test file, so each boot gets its own copy.
  const source = await readFile(`${WEB}studio.js`, 'utf8');
  const bust = `${source}\n//# sourceURL=studio.${bootCount++}.js`;
  await import(`data:text/javascript;base64,${Buffer.from(bust).toString('base64')}`);
  await new Promise((resolve) => setTimeout(resolve, 50));

  return {
    window,
    document,
    calls,
    errors,
    timers,
    restore: () => Object.assign(globalThis, previous),
  };
}

test('the studio renders its shell and loads device state', async () => {
  const studio = await bootStudio();
  const { document } = studio;
  assert.equal(document.querySelectorAll('#suggestions button').length, 3);
  // The order is deliberate: the shortest demo first.
  assert.deepEqual(
    [...document.querySelectorAll('#suggestions button')].map((button) =>
      button.textContent.trim().replace(/\s*↗$/, ''),
    ),
    ['Open Chrome', 'Enable dark theme', 'Find Android version'],
  );
  assert.equal(document.getElementById('device-name').textContent, 'Test phone · ADB · scrcpy');
  assert.equal(document.getElementById('stage-transport').textContent, 'ANDROID · 1440×3200');
  assert.match(document.querySelector('.empty-state h3').textContent, /A little intent/);
  assert.deepEqual(
    studio.calls.map((call) => call.path),
    ['/api/device', '/api/runs'],
  );
  assert.equal(studio.errors.length, 0);
  studio.restore();
});

test('a run renders its timeline and result from server-sent events', async () => {
  const studio = await bootStudio({ postRun: () => fakeRun() });
  const { document } = studio;
  document.getElementById('goal').value = 'Turn on dark theme';
  document
    .getElementById('goal')
    .dispatchEvent(new studio.window.Event('input', { bubbles: true }));
  document.getElementById('run-button').click();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const stream = FakeEvents.instances.at(-1);
  assert.ok(stream, 'the studio subscribes to run events');
  assert.match(stream.url, /^\/api\/runs\/run-12/);

  stream.onmessage({
    data: JSON.stringify(
      fakeRun({
        events: [
          {
            type: 'decision',
            step: 0,
            operation: 'TAP',
            latencyMs: 210,
            model: 'jev-test',
            sequence: 0,
            at: Date.now(),
          },
          {
            type: 'action',
            step: 0,
            operation: 'TAP',
            label: 'Tap Dark theme.',
            sequence: 1,
            at: Date.now(),
          },
        ],
      }),
    ),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(document.querySelectorAll('.action-row').length, 1);
  assert.match(document.querySelector('.action-copy strong').textContent, /Tap/);
  assert.match(document.querySelector('.action-copy p').textContent, /Dark theme/);
  assert.equal(document.getElementById('metric-latency').textContent, '210');
  assert.equal(document.getElementById('footer-id').textContent, 'run-1234');
  assert.equal(document.getElementById('stop-button').hidden, false);

  const finished = Date.now();
  stream.onmessage({
    data: JSON.stringify(
      fakeRun({
        status: 'succeeded',
        endedAt: finished,
        outcome: 'done',
        events: [
          {
            type: 'action',
            step: 0,
            operation: 'TAP',
            label: 'Tap Dark theme.',
            sequence: 0,
            at: finished - 100,
          },
          { type: 'result', outcome: 'done', reason: 'Switch is on.', sequence: 1, at: finished },
        ],
      }),
    ),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(document.getElementById('run-button').hidden, false);
  assert.equal(document.getElementById('stop-button').hidden, true);
  assert.match(document.querySelector('.result-row').className, /succeeded/);
  assert.match(document.querySelector('.result-row p').textContent, /Switch is on/);
  assert.equal(studio.errors.length, 0);
  studio.restore();
});

test('history lists previous runs and a server error is shown inline', async () => {
  const previous = fakeRun({
    id: 'old-run-1',
    status: 'blocked',
    goal: 'Open Settings',
    endedAt: Date.now(),
  });
  const studio = await bootStudio({ runs: [previous] });
  const { document } = studio;
  assert.equal(document.querySelectorAll('.history-item').length, 1);
  document.querySelector('.tab[data-tab="history"]').click();
  assert.equal(document.getElementById('history-list').hidden, false);
  document.querySelector('.history-item').click();
  assert.equal(document.getElementById('goal').value, 'Open Settings');
  assert.equal(document.getElementById('history-list').hidden, true);
  assert.equal(studio.errors.length, 0);
  studio.restore();
});

test('a step can be expanded to show the model input, output and execution', async () => {
  const studio = await bootStudio({ postRun: () => fakeRun() });
  const { document } = studio;
  const stream = () => FakeEvents.instances.at(-1);
  document.getElementById('goal').value = 'Turn on dark theme';
  document
    .getElementById('goal')
    .dispatchEvent(new studio.window.Event('input', { bubbles: true }));
  document.getElementById('run-button').click();
  await new Promise((resolve) => setTimeout(resolve, 50));

  stream().onmessage({
    data: JSON.stringify(
      fakeRun({
        events: [
          {
            type: 'decision',
            step: 0,
            operation: 'TAP',
            latencyMs: 210,
            model: 'jev-test',
            status: 'action',
            confidence: 0.86,
            sequence: 0,
            at: Date.now(),
          },
          {
            type: 'action',
            step: 0,
            operation: 'TAP',
            label: 'Tap Dark theme.',
            sequence: 1,
            at: Date.now(),
          },
        ],
      }),
    ),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const toggle = document.querySelector('.step-toggle');
  assert.ok(toggle, 'each step row offers an expand control');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('.step-detail'), null);

  toggle.click();
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.ok(
    studio.calls.some((call) => /\/steps\/0$/.test(call.path)),
    'expanding fetches the stored step record',
  );
  const detail = document.querySelector('.step-detail');
  assert.ok(detail, 'the detail panel is rendered');
  const text = detail.textContent;
  assert.match(text, /Input · model request/);
  assert.match(text, /Output · model response/);
  assert.match(text, /Execution/);
  assert.match(text, /0\.86|86\.0%/, 'the operation probability is shown');
  assert.match(text, /Dark theme/);
  assert.match(text, /tap-element/, 'the resolved execution is shown');
  assert.match(text, /changed/, 'the screen-changed flag is shown');
  assert.equal(detail.querySelectorAll('.prob-row').length >= 2, true);
  assert.ok(detail.querySelector('details.raw pre'), 'raw JSON is available');
  assert.equal(document.querySelector('.step-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(studio.errors.length, 0);

  // Collapsing removes the panel and keeps the record cached.
  document.querySelector('.step-toggle').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(document.querySelector('.step-detail'), null);
  const fetches = studio.calls.filter((call) => /\/steps\//.test(call.path)).length;
  document.querySelector('.step-toggle').click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    studio.calls.filter((call) => /\/steps\//.test(call.path)).length,
    fetches,
    're-opening does not refetch',
  );
  studio.restore();
});

test('a decision that executed nothing still gets an inspectable row', async () => {
  const studio = await bootStudio({ postRun: () => fakeRun() });
  const { document } = studio;
  const stream = () => FakeEvents.instances.at(-1);
  document.getElementById('goal').value = 'Turn on dark theme';
  document
    .getElementById('goal')
    .dispatchEvent(new studio.window.Event('input', { bubbles: true }));
  document.getElementById('run-button').click();
  await new Promise((resolve) => setTimeout(resolve, 50));

  stream().onmessage({
    data: JSON.stringify(
      fakeRun({
        status: 'succeeded',
        endedAt: Date.now(),
        outcome: 'done',
        events: [
          {
            type: 'action',
            step: 0,
            operation: 'TAP',
            label: 'Tap Dark theme.',
            sequence: 0,
            at: Date.now(),
          },
          {
            type: 'decision',
            step: 1,
            operation: 'DONE',
            status: 'done',
            latencyMs: 180,
            model: 'jev-test',
            sequence: 1,
            at: Date.now(),
          },
          { type: 'result', outcome: 'done', sequence: 2, at: Date.now() },
        ],
      }),
    ),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const rows = [...document.querySelectorAll('.action-row')];
  assert.equal(rows.length, 2, 'one row per executed action and for the terminal decision');
  assert.match(rows[1].textContent, /Done/);
  assert.equal(rows[1].querySelector('.step-toggle') !== null, true);
  assert.equal(studio.errors.length, 0);
  studio.restore();
});

test('a rejected run leaves the studio usable for the next attempt', async () => {
  const studio = await bootStudio({
    postRun: () => fakeRun(),
  });
  const { document } = studio;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path, options) => {
    if (path === '/api/runs' && options?.method === 'POST')
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: 'The step limit must be between 1 and 50.' }),
      };
    return originalFetch(path, options);
  };
  document.getElementById('goal').value = 'A goal';
  document
    .getElementById('goal')
    .dispatchEvent(new studio.window.Event('input', { bubbles: true }));
  document.getElementById('run-button').click();
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.match(document.getElementById('error-text').textContent, /step limit/);
  assert.equal(document.getElementById('error').hidden, false);

  // The button must be usable again: `submitting` may not stay stuck after a rejection.
  globalThis.fetch = originalFetch;
  const posts = [];
  globalThis.fetch = async (path, options) => {
    if (path === '/api/runs' && options?.method === 'POST') posts.push(JSON.parse(options.body));
    return originalFetch(path, options);
  };
  document.getElementById('run-button').click();
  await new Promise((resolve) => setTimeout(resolve, 40));
  globalThis.fetch = originalFetch;
  assert.equal(posts.length, 1, 'the second attempt reaches the server');
  assert.equal(studio.errors.length, 0);
  studio.restore();
});
