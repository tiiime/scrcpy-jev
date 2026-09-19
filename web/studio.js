// scrcpy-jev studio: one page, no build step.
//
// The live view is the real scrcpy H.264 stream decoded with WebCodecs. Browsers without it fall
// back to polling the ADB screenshot endpoint, so the studio still works everywhere.
const $ = (id) => document.getElementById(id);

const state = {
  device: null,
  run: null,
  runs: [],
  panel: 'activity',
  now: 0,
  submitting: false,
  clearing: false,
  connected: false,
  streamMode: 'connecting',
  actions: [],
  decisions: [],
  video: null,
  // Expanded step records survive the full re-render that every server event triggers.
  expanded: new Set(),
  records: new Map(),
};

/* ------------------------------------------------------------------ helpers */

const isActive = (run) => Boolean(run && ['running', 'stopping'].includes(run.status));

const statusLabels = {
  running: 'In progress',
  stopping: 'Stopping',
  succeeded: 'Completed',
  stopped: 'Stopped',
  blocked: 'Needs attention',
  failed: 'Run failed',
};

const EXAMPLES = [
  { label: 'Open Chrome', goal: 'Open Chrome and leave the browser visible on screen.' },
  {
    label: 'Enable dark theme',
    goal: 'Turn on dark theme in Android Settings. Stop with the dark theme switch visible and on.',
  },
  {
    label: 'Find Android version',
    goal: 'Show the Android version of this device in Android Settings and leave it visible. Search android phone.',
  },
];

function clock(ms) {
  const seconds = Math.floor(ms / 1000);
  return {
    main: `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`,
    fraction: String(Math.floor((ms % 1000) / 10)).padStart(2, '0'),
  };
}

function operationName(operation) {
  return (
    {
      TAP: 'Tap',
      OPEN_APP: 'Open app',
      TYPE_TEXT: 'Type text',
      SCROLL_DOWN: 'Scroll down',
      SCROLL_UP: 'Scroll up',
      SCROLL_LEFT: 'Scroll left',
      SCROLL_RIGHT: 'Scroll right',
      HOME: 'Home',
      BACK: 'Back',
      WAIT: 'Wait',
      ENTER: 'Enter',
    }[operation || ''] ||
    operation ||
    'Action'
  );
}

function actionDetail(event) {
  const label = event.label || event.operation || 'Action';
  if (event.operation === 'TAP') return label.replace(/^Tap /, '').replace(/\.$/, '');
  if (event.operation?.startsWith('SCROLL')) return 'Move through the current screen';
  if (event.operation === 'TYPE_TEXT') {
    try {
      return `“${JSON.parse(label).text}”`;
    } catch {
      return label;
    }
  }
  return (
    {
      HOME: 'Return to the home screen',
      BACK: 'Go back one screen',
      WAIT: 'Give the app a moment to load',
      ENTER: 'Submit the current input',
    }[event.operation || ''] || label
  );
}

function error(message) {
  $('error-text').textContent = message;
  $('error').hidden = !message;
}

async function api(path, options) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

/* ------------------------------------------------------------------ rendering */

/** Pairs each decision with the action it produced, including terminal decisions. */
function buildSteps(run) {
  if (!run) return [];
  const decisions = run.events.filter((event) => event.type === 'decision');
  const actions = run.events.filter((event) => event.type === 'action');
  const steps = decisions.map((decision) => ({
    step: decision.step,
    decision,
    action: actions.find((action) => action.step === decision.step) || null,
  }));
  for (const action of actions)
    if (!steps.some((entry) => entry.step === action.step))
      steps.push({ step: action.step, decision: null, action });
  return steps.sort((left, right) => left.step - right.step);
}

function stepKey(step) {
  return `${state.run?.id}:${step}`;
}

function stepLabel(entry) {
  if (entry.action) return operationName(entry.action.operation);
  const status = entry.decision?.status;
  return (
    { done: 'Done', blocked: 'Blocked', uncertain: 'Uncertain', needs_input: 'Needs input' }[
      status
    ] ||
    operationName(entry.decision?.operation) ||
    'Decision'
  );
}

function stepDetailText(entry) {
  if (entry.action) return actionDetail(entry.action);
  if (entry.decision?.reason) return entry.decision.reason;
  return (
    {
      done: 'Jev reported the goal as visibly satisfied.',
      blocked: 'No offered operation could advance the goal.',
      uncertain: 'The decision fell below the confidence threshold.',
      needs_input: 'A field value was missing from the goal.',
    }[entry.decision?.status] || 'No action was executed for this decision.'
  );
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function probabilityRows(probabilities) {
  if (!probabilities || typeof probabilities !== 'object') return '';
  return Object.entries(probabilities)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 12)
    .map(
      ([key, value]) => `
        <div class="prob-row">
          <span class="prob-key">${escapeHtml(key)}</span>
          <span class="prob-bar"><i style="width:${Math.max(0, Math.min(1, value)) * 100}%"></i></span>
          <span class="prob-value">${(value * 100).toFixed(1)}%</span>
        </div>`,
    )
    .join('');
}

function criteriaRows(criteria, limit = 40) {
  if (!criteria) return '<p class="io-empty">None offered.</p>';
  const entries = Object.entries(criteria);
  const shown = entries.slice(0, limit);
  return `
    <ul class="io-list">
      ${shown
        .map(
          ([key, value]) =>
            `<li><code>${escapeHtml(key)}</code><span>${escapeHtml(
              typeof value === 'string' ? value : JSON.stringify(value),
            ).slice(0, 220)}</span></li>`,
        )
        .join('')}
    </ul>
    ${entries.length > shown.length ? `<p class="io-more">+${entries.length - shown.length} more</p>` : ''}`;
}

function rawJson(label, value) {
  if (value === null || value === undefined) return '';
  return `<details class="raw"><summary>${escapeHtml(label)} JSON</summary><pre>${escapeHtml(
    JSON.stringify(value, null, 2),
  )}</pre></details>`;
}

function renderRecord(record) {
  if (record === 'loading')
    return '<p class="io-empty"><span class="spin">◌</span> Loading step record…</p>';
  if (!record || record.error)
    return `<p class="io-empty">${escapeHtml(record?.error || 'No record.')}</p>`;
  if (record.truncated)
    return `<p class="io-empty">The record was too large to keep: ${escapeHtml(record.reason || '')}</p>`;

  const request = record.request || null;
  const response = record.response || null;
  const decision = record.decision || null;
  const execution = record.execution || null;
  const before = record.before || null;
  const after = record.after || null;
  const answers = response?.answers || {};
  const questions = request?.questions || {};
  const state_ = request?.state || {};
  const answered = Object.keys(answers);

  const targetQuestion = answered.find((name) => name !== 'operation');
  const targetAnswer = targetQuestion ? answers[targetQuestion] : null;

  const requestBytes = request ? JSON.stringify(request).length : 0;
  const responseBytes = response ? JSON.stringify(response).length : 0;

  return `
    <div class="io-grid">
      <section class="io-card">
        <h4>Input · model request <span>${formatBytes(requestBytes)}</span></h4>
        <div class="io-chips">
          <span class="chip">${escapeHtml(request?.model || 'unknown model')}</span>
          <span class="chip">${state_.elements?.length ?? 0} elements</span>
          <span class="chip">${state_.availableApps?.length ?? 0} apps</span>
          <span class="chip">${state_.recentActions?.length ?? 0} recent actions</span>
          ${state_.textSource ? `<span class="chip">text: ${escapeHtml(state_.textSource)}</span>` : ''}
        </div>
        <dl class="io-meta">
          <div><dt>goal</dt><dd>${escapeHtml(state_.goal || '—')}</dd></div>
          <div><dt>foreground</dt><dd><code>${escapeHtml(state_.app || '—')}</code></dd></div>
          <div><dt>editable</dt><dd>${state_.isEditable ? 'yes' : 'no'}${
            state_.focusedField ? ` · focused: ${escapeHtml(state_.focusedField.label || '')}` : ''
          }</dd></div>
        </dl>
        ${
          state_.elements?.length
            ? `<details class="raw"><summary>offered controls (${state_.elements.length})</summary>${criteriaRows(
                Object.fromEntries(
                  state_.elements.map((element) => [
                    element.index,
                    `${element.label}${
                      element.operations?.length ? ` [${element.operations.join(', ')}]` : ''
                    }${element.checked === true ? ' (checked)' : ''}`,
                  ]),
                ),
              )}</details>`
            : ''
        }
        ${
          questions.operation
            ? `<details class="raw"><summary>operation question (${
                Object.keys(questions.operation.criteria || {}).length
              } options)</summary>${criteriaRows(questions.operation.criteria)}</details>`
            : ''
        }
        ${targetQuestion && questions[targetQuestion] ? `<details class="raw"><summary>${escapeHtml(targetQuestion)} (${Object.keys(questions[targetQuestion].criteria || {}).length} options)</summary>${criteriaRows(questions[targetQuestion].criteria)}</details>` : ''}
        ${
          state_.availableApps?.length
            ? `<details class="raw"><summary>installed apps offered (${state_.availableApps.length})</summary>${criteriaRows(
                Object.fromEntries(
                  state_.availableApps.map((app) => [
                    app.index,
                    `${app.label} (${app.packageName})`,
                  ]),
                ),
              )}</details>`
            : ''
        }
        ${
          state_.visibleText?.length
            ? `<details class="raw"><summary>visible text (${state_.visibleText.length})</summary><pre>${escapeHtml(
                state_.visibleText.join('\n'),
              )}</pre></details>`
            : ''
        }
        ${rawJson('request', request)}
      </section>

      <section class="io-card">
        <h4>Output · model response <span>${formatBytes(responseBytes)}</span></h4>
        ${
          answers.operation
            ? `<div class="io-choice">
                 <span class="io-choice-label">operation</span>
                 <strong>${escapeHtml(String(answers.operation.choice))}</strong>
                 <span class="io-confidence">${((answers.operation.confidence ?? 0) * 100).toFixed(1)}%</span>
               </div>
               <div class="prob-list">${probabilityRows(answers.operation.probabilities)}</div>`
            : '<p class="io-empty">No operation answer.</p>'
        }
        ${
          targetAnswer
            ? `<div class="io-choice">
                 <span class="io-choice-label">${escapeHtml(targetQuestion)}</span>
                 <strong>${escapeHtml(String(targetAnswer.choice))}</strong>
                 <span class="io-confidence">${((targetAnswer.confidence ?? 0) * 100).toFixed(1)}%</span>
               </div>
               <div class="prob-list">${probabilityRows(targetAnswer.probabilities)}</div>`
            : ''
        }
        <dl class="io-meta">
          <div><dt>model</dt><dd>${escapeHtml(response?.model || decision?.responseModel || '—')}</dd></div>
          <div><dt>latency</dt><dd>${decision?.latencyMs != null ? `${Math.round(decision.latencyMs)} ms` : '—'}</dd></div>
          <div><dt>status</dt><dd><code>${escapeHtml(decision?.status || '—')}</code>${
            decision?.reason ? ` · ${escapeHtml(decision.reason)}` : ''
          }</dd></div>
        </dl>
        ${
          decision?.usage
            ? `<div class="io-chips">${Object.entries(decision.usage)
                .map(
                  ([key, value]) =>
                    `<span class="chip">${escapeHtml(key)}: ${escapeHtml(String(value))}</span>`,
                )
                .join('')}</div>`
            : ''
        }
        ${rawJson('response', response)}
      </section>
    </div>

    ${
      execution || before || after
        ? `<section class="io-card io-execution">
             <h4>Execution</h4>
             ${
               execution?.executed
                 ? `<p class="io-executed"><code>${escapeHtml(JSON.stringify(execution.executed))}</code>${
                     execution.verified ? ' · field value verified by read-back' : ''
                   }</p>`
                 : execution
                   ? `<p class="io-executed"><code>${escapeHtml(JSON.stringify(execution.action))}</code></p>`
                   : ''
             }
             <dl class="io-meta">
               ${
                 before
                   ? `<div><dt>before</dt><dd><code>${escapeHtml(before.packageName || '—')}</code> · ${
                       before.elements
                     } elements · <code>${escapeHtml(before.fingerprint.slice(0, 10))}</code></dd></div>`
                   : ''
               }
               ${
                 after
                   ? `<div><dt>after</dt><dd><code>${escapeHtml(after.packageName || '—')}</code> · ${
                       after.elements
                     } elements · <code>${escapeHtml(after.fingerprint.slice(0, 10))}</code></dd></div>`
                   : ''
               }
               ${
                 record.screenChanged !== undefined
                   ? `<div><dt>screen</dt><dd>${record.screenChanged ? 'changed' : 'unchanged'}</dd></div>`
                   : ''
               }
             </dl>
             ${rawJson('action', execution?.action ?? null)}
           </section>`
        : ''
    }`;
}

async function toggleStep(step) {
  const key = stepKey(step);
  if (state.expanded.has(key)) {
    state.expanded.delete(key);
    renderActivity();
    return;
  }
  state.expanded.add(key);
  renderActivity();
  if (state.records.has(key)) return;
  state.records.set(key, 'loading');
  renderActivity();
  try {
    const record = await api(`/api/runs/${state.run.id}/steps/${step}`);
    state.records.set(key, record);
  } catch (failure) {
    state.records.set(key, { error: failure.message });
  }
  renderActivity();
}

function renderTelemetry() {
  const run = state.run;
  const busy = isActive(run);
  const elapsed = run ? Math.max(0, (run.endedAt ?? state.now) - run.startedAt) : 0;
  const timer = clock(elapsed);
  $('clock-main').textContent = timer.main;
  $('clock-fraction').textContent = `.${timer.fraction}`;
  $('clock-live').hidden = !busy;
  $('telemetry').classList.toggle('running', busy);
  $('metric-actions').textContent = String(state.actions.length).padStart(2, '0');
  $('metric-actions-note').textContent = run ? `of ${run.maxSteps} allowed` : 'ready to execute';
  const latencies = state.decisions.map((event) => event.latencyMs).filter(Number.isFinite);
  $('metric-latency').textContent = latencies.length
    ? String(Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length))
    : '—';
  const latest = state.decisions.at(-1);
  $('model-name').textContent = latest?.model || state.device?.model || 'jev-latest';
}

function renderActivity() {
  const run = state.run;
  const busy = isActive(run);
  const body = $('activity-body');
  $('action-count').hidden = state.actions.length === 0;
  $('action-count').textContent = String(state.actions.length);
  $('task-status').className = `task-status ${run?.status || ''}`;
  $('task-status').querySelector('span').textContent = run ? statusLabels[run.status] : 'Standby';
  $('footer-id').textContent = run ? run.id.slice(0, 8) : 'SESSION READY';
  $('footer-state').textContent = busy ? 'Streaming agent events' : 'All actions selected by Jev';
  $('stream-dot').classList.toggle('on', busy);
  $('stop-button').hidden = !busy;
  $('stop-label').textContent = run?.status === 'stopping' ? 'Stopping…' : 'Stop task';
  $('run-button').hidden = busy;
  $('run-button').disabled =
    !$('goal').value.trim() || state.submitting || state.clearing || state.runs.some(isActive);
  $('clear-button').disabled =
    state.runs.some(isActive) || state.submitting || state.clearing || (!state.runs.length && !run);

  if (state.panel === 'history') {
    body.hidden = true;
    $('history-list').hidden = false;
    return;
  }
  body.hidden = false;
  $('history-list').hidden = true;

  if (!run) {
    body.innerHTML = `
      <div class="empty-state">
        <div class="empty-orbit">
          <svg viewBox="0 0 24 24" width="23" height="23" aria-hidden="true"><path d="M5 3l14 9-14 9z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
          <span></span><span></span>
        </div>
        <h3>A little intent goes a long way.</h3>
        <p>Your agent&rsquo;s actions will appear here,<br />one decision at a time.</p>
        <div class="empty-steps"><span>Observe</span>→<span>Decide</span>→<span>Act</span></div>
      </div>`;
    return;
  }

  const scroll = body.scrollTop;
  const steps = buildSteps(run);
  const rows = steps
    .map((entry, index) => {
      const key = stepKey(entry.step);
      const open = state.expanded.has(key);
      const record = state.records.get(key);
      const latency = entry.decision?.latencyMs;
      return `
        <div class="action-row ${open ? 'open' : ''}">
          <span class="action-number">${String(index + 1).padStart(2, '0')}</span>
          <div class="action-icon">${icon(entry.action?.operation || entry.decision?.operation)}</div>
          <div class="action-copy">
            <strong>${escapeHtml(stepLabel(entry))}</strong>
            <p>${escapeHtml(stepDetailText(entry))}</p>
          </div>
          <div class="action-meta">
            <span>${latency ? `${Math.round(latency)} ms` : '—'}</span>
            <small>${
              entry.action
                ? '✓ executed'
                : `<span class="status-note">${escapeHtml(entry.decision?.status || 'decision')}</span>`
            }</small>
          </div>
          <button class="step-toggle" data-step="${entry.step}" aria-expanded="${open}"
                  title="${open ? 'Hide' : 'Show'} model input and output">
            <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span class="sr-only">Toggle details</span>
          </button>
          ${open ? `<div class="step-detail">${renderRecord(record ?? 'loading')}</div>` : ''}
        </div>`;
    })
    .join('');

  const result = run.endedAt
    ? `<div class="result-row ${run.status}">
         <div>${run.status === 'succeeded' ? '✓' : '■'}</div>
         <span>
           <strong>${escapeHtml(statusLabels[run.status] || run.status)}</strong>
           <p>${escapeHtml(resultMessage(run))}</p>
         </span>
       </div>`
    : '';

  body.innerHTML = `
    <div class="run-start">
      <div class="timeline-dot">
        <svg viewBox="0 0 24 24" width="9" height="9" aria-hidden="true"><path d="M6 4l14 8-14 8z" fill="currentColor"/></svg>
      </div>
      <div>
        <strong>Task started</strong>
        <span>${new Date(run.startedAt).toLocaleTimeString()}</span>
      </div>
    </div>
    ${rows}
    ${
      busy
        ? `<div class="thinking-row">
             <svg class="spin" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
             <span>${run.status === 'stopping' ? 'Finishing the current action…' : 'Jev is observing and deciding…'}</span>
             <span class="thinking-dots">···</span>
           </div>`
        : ''
    }
    ${result}`;
  for (const button of body.querySelectorAll('.step-toggle'))
    button.addEventListener('click', () => toggleStep(Number(button.dataset.step)));
  // Follow new steps, but never jump while the operator is reading an expanded record.
  const previous = Number(body.dataset.steps || 0);
  if (steps.length !== previous) {
    body.dataset.steps = String(steps.length);
    body.scrollTop = body.scrollHeight;
  } else {
    body.scrollTop = scroll;
  }
}

function resultMessage(run) {
  if (run.error) return run.error;
  const reason = [...run.events].reverse().find((event) => event.type === 'result')?.reason;
  if (reason) return reason;
  if (run.status === 'succeeded') return 'Jev reports the goal is complete. The device is yours.';
  if (run.status === 'stopped') return 'The task has stopped. You can start a new goal.';
  return `The agent stopped: ${String(run.outcome || 'unknown').replaceAll('_', ' ')}.`;
}

function icon(operation) {
  if (operation === 'WAIT')
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  if (operation?.startsWith('SCROLL'))
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  if (operation === 'TYPE_TEXT')
    return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M9 10V6a2 2 0 0 1 4 0v4M9 10v4a3 3 0 0 0 6 0v-4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 3l14 9-14 9z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
}

function renderHistory() {
  const list = $('history-list');
  if (!state.runs.length) {
    list.innerHTML =
      '<div class="empty-history"><h3>A fresh start.</h3><p>Your recent runs will live here.</p></div>';
    return;
  }
  list.innerHTML = state.runs
    .map(
      (run) => `
      <button class="history-item" data-run="${run.id}">
        <div>
          <span class="history-dot ${run.status}"></span>
          <strong>${escapeHtml(run.goal)}</strong>
        </div>
        <p>
          ${escapeHtml(statusLabels[run.status] || run.status)}
          <span>${new Date(run.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${
            run.endedAt ? ` · ${((run.endedAt - run.startedAt) / 1000).toFixed(2)}s` : ''
          }</span>
        </p>
      </button>`,
    )
    .join('');
  for (const button of list.querySelectorAll('[data-run]')) {
    button.addEventListener('click', () => {
      const run = state.runs.find((item) => item.id === button.dataset.run);
      if (!run) return;
      selectRun(run);
      setPanel('activity');
    });
  }
}

function selectRun(run) {
  state.run = run;
  state.actions = run.events.filter((event) => event.type === 'action');
  state.decisions = run.events.filter((event) => event.type === 'decision');
  $('goal').value = run.goal;
  renderAll();
}

function renderAll() {
  renderTelemetry();
  renderActivity();
  renderHistory();
}

function setPanel(panel) {
  state.panel = panel;
  for (const button of document.querySelectorAll('.rail-button')) {
    button.classList.toggle('selected', button.dataset.panel === panel);
  }
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.tab === panel);
  }
  renderActivity();
}

/* ------------------------------------------------------------------ runs */

function updateRun(run) {
  state.run = run;
  state.runs = [run, ...state.runs.filter((item) => item.id !== run.id)].slice(0, 30);
  state.actions = run.events.filter((event) => event.type === 'action');
  state.decisions = run.events.filter((event) => event.type === 'decision');
  renderAll();
}

let events = null;

function subscribe(runId) {
  events?.close();
  events = new EventSource(`/api/runs/${runId}/events`);
  events.onmessage = (message) => updateRun(JSON.parse(message.data));
  events.onerror = () => {
    /* EventSource reconnects on its own. */
  };
}

async function start() {
  const goal = $('goal').value.trim();
  if (!goal || state.submitting) return;
  // Everything after this point stays inside try/finally: a rendering throw must never leave
  // `submitting` stuck, which would disable the run button for the rest of the session.
  state.submitting = true;
  try {
    error('');
    setPanel('activity');
    renderActivity();
    const run = await api('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal, maxSteps: Number($('max-steps').value) }),
    });
    state.now = Date.now();
    updateRun(run);
    subscribe(run.id);
  } catch (failure) {
    error(failure.message || 'The task could not be started.');
  } finally {
    state.submitting = false;
    renderActivity();
  }
}

async function stop() {
  if (!state.run || state.run.status === 'stopping') return;
  try {
    updateRun(await api(`/api/runs/${state.run.id}/stop`, { method: 'POST' }));
  } catch (failure) {
    error(failure.message);
  }
}

async function clear() {
  if (state.clearing) return;
  state.clearing = true;
  renderActivity();
  try {
    await api('/api/runs/clear', { method: 'POST' });
    state.run = null;
    state.runs = [];
    state.now = 0;
    state.actions = [];
    state.decisions = [];
    state.expanded.clear();
    state.records.clear();
    events?.close();
    error('');
    renderAll();
  } catch (failure) {
    error(failure.message);
  } finally {
    state.clearing = false;
    renderActivity();
  }
}

/* ------------------------------------------------------------------ device stream */

const canvas = $('screen');
const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
let decoder = null;
let socket = null;
let timestamp = 0;
let snapshotTimer = null;
let reconnectTimer = null;
let watchdog = null;
let lastFrameAt = 0;
let resyncs = 0;
let resyncWindowStart = 0;
// Frames that arrived before the decoder was configured. Dropping them would start decoding in the
// middle of a group of pictures, which is exactly how a decoder error loop begins.
let pendingFrames = [];
// scrcpy sends its SPS/PPS once, in a packet of its own. WebCodecs rejects a chunk that holds only
// parameter sets ("a key frame is required after configure"), so they ride along with the next IDR.
let pendingParameterSets = null;

function setConnection(mode, note) {
  state.streamMode = mode;
  const badge = $('connection-badge');
  badge.className = `connection-badge${mode === 'live' ? ' live' : mode === 'offline' ? ' offline' : ''}`;
  badge.querySelector('span').textContent =
    mode === 'live' ? 'LIVE' : mode === 'offline' ? 'OFFLINE' : 'CONNECTING';
  $('stream-error').hidden = mode === 'live';
  if (mode !== 'live' && !note)
    $('stream-error-text').textContent = state.streamSeen
      ? 'Lost the video stream. Reconnecting…'
      : 'Waiting for the scrcpy stream from the studio server…';
  if (note) {
    $('stream-note').hidden = false;
    $('stream-note').textContent = note;
  } else {
    $('stream-note').hidden = true;
  }
  $('stage-caption').textContent = isActive(state.run)
    ? 'Agent in control'
    : mode === 'live'
      ? 'Touch & keyboard enabled'
      : 'Reconnecting…';
}

function resizeCanvas(width, height) {
  if (!width || !height) return;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    state.video = { width, height };
  }
}

/**
 * Configures the decoder synchronously so it is ready before the binary frames that follow the
 * metadata message are handled.
 */
function configureDecoder(metadata) {
  if (!metadata?.codec || !metadata.width || !metadata.height) return false;
  resizeCanvas(metadata.width, metadata.height);
  if (typeof VideoDecoder === 'undefined') return false;
  closeDecoder();
  pendingFrames = [];
  pendingParameterSets = null;
  try {
    const next = new VideoDecoder({
      output(frame) {
        context.drawImage(frame, 0, 0, canvas.width, canvas.height);
        frame.close();
        lastFrameAt = performance.now();
        resyncs = 0;
        setConnection('live', null);
      },
      error(failure) {
        console.error('[scrcpy-jev] video decode failed:', failure?.message || failure);
        closeDecoder();
        resync('decode error');
      },
    });
    next.configure({
      codec: metadata.codec,
      codedWidth: metadata.width,
      codedHeight: metadata.height,
      avc: { format: 'annexb' },
      optimizeForLatency: true,
    });
    decoder = next;
  } catch (failure) {
    console.error('[scrcpy-jev] could not configure the decoder:', failure?.message || failure);
    closeDecoder();
    return false;
  }
  lastFrameAt = performance.now();
  startDecodeWatchdog();
  return true;
}

function closeDecoder() {
  const previous = decoder;
  decoder = null;
  if (!previous) return;
  try {
    if (previous.state !== 'closed') previous.close();
  } catch {
    // Already closed by the decoder itself.
  }
}

/**
 * scrcpy only emits a key frame when its encoder decides to, so a broken decode is fixed by
 * reconnecting: the hub replays the current group of pictures. Repeated failures fall back to
 * screenshots rather than reconnecting forever.
 */
function resync(reason) {
  if (snapshotTimer) return;
  const now = performance.now();
  if (now - resyncWindowStart > 20_000) {
    resyncWindowStart = now;
    resyncs = 0;
  }
  if (++resyncs > 4) {
    startSnapshotFallback(`The H.264 stream kept failing to decode (${reason})`);
    return;
  }
  socket?.close();
}

function startDecodeWatchdog() {
  clearInterval(watchdog);
  const configuredAt = performance.now();
  watchdog = setInterval(() => {
    if (snapshotTimer) return;
    const reference = lastFrameAt || configuredAt;
    if (performance.now() - reference < 6000) return;
    clearInterval(watchdog);
    startSnapshotFallback('The H.264 stream produced no frames');
  }, 1000);
}

function decodeFrame(bytes) {
  if (!decoder || decoder.state !== 'configured') {
    // Bounded: a stalled decoder must not grow an unbounded buffer.
    if (pendingFrames.length < 400) pendingFrames.push(bytes);
    return;
  }
  while (pendingFrames.length) decodeChunk(pendingFrames.shift());
  decodeChunk(bytes);
}

const FLAG_CONFIGURATION = 1;
const FLAG_KEYFRAME = 2;

function decodeChunk(bytes) {
  if (!bytes.length) return;
  const flags = bytes[0];
  let payload = bytes.subarray(1);
  if (!payload.length) return;
  if (flags & FLAG_CONFIGURATION) {
    // Never decode parameter sets on their own: attach them to the key frame that follows.
    pendingParameterSets = payload;
    return;
  }
  const key = (flags & FLAG_KEYFRAME) !== 0;
  if (key && pendingParameterSets) {
    const merged = new Uint8Array(pendingParameterSets.length + payload.length);
    merged.set(pendingParameterSets, 0);
    merged.set(payload, pendingParameterSets.length);
    payload = merged;
    pendingParameterSets = null;
  }
  timestamp += 16_667;
  try {
    decoder.decode(
      new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp, data: payload }),
    );
  } catch (failure) {
    console.error('[scrcpy-jev] dropping a frame:', failure?.message || failure);
  }
}

function connect() {
  clearTimeout(reconnectTimer);
  socket?.close();
  socket = new WebSocket(
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/stream`,
  );
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => {
    $('stream-error').hidden = true;
    $('stream-error-text').textContent = 'Waiting for the first video frame…';
  };
  socket.onclose = () => {
    // The screenshot fallback owns the badge once it is running.
    if (snapshotTimer) return;
    setConnection('offline', null);
    reconnectTimer = setTimeout(connect, 1500);
  };
  socket.onerror = () => {
    if (!snapshotTimer) setConnection('offline', null);
  };
  socket.onmessage = (message) => {
    if (typeof message.data === 'string') {
      const payload = JSON.parse(message.data);
      if (payload.type === 'video') {
        state.streamSeen = true;
        if (!configureDecoder(payload))
          startSnapshotFallback('H.264 decoding is unavailable in this browser');
      } else if (payload.type === 'error') {
        error(payload.message);
      }
      return;
    }
    decodeFrame(new Uint8Array(message.data));
  };
}

/**
 * Last resort for browsers without WebCodecs, or when the stream cannot be decoded. Requests are
 * chained instead of polled on a timer: `screencap` takes seconds on a large screen, and firing a
 * new request every 260 ms only queues work the device cannot do.
 */
function startSnapshotFallback(reason) {
  if (snapshotTimer) return;
  clearInterval(watchdog);
  setConnection('live', `${reason}. Falling back to screenshots.`);
  let cancelled = false;
  snapshotTimer = { cancel: () => (cancelled = true) };
  socket?.close();
  const tick = async () => {
    if (cancelled) return;
    await new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        resizeCanvas(image.naturalWidth, image.naturalHeight);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        $('stream-error').hidden = true;
        resolve();
      };
      image.onerror = resolve;
      image.src = `/api/snapshot?t=${Date.now()}`;
    });
    if (!cancelled) setTimeout(tick, 120);
  };
  tick();
}

function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function normalized(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  };
}

let drag = null;

canvas.addEventListener('pointerdown', (event) => {
  canvas.setPointerCapture(event.pointerId);
  drag = { ...normalized(event), at: performance.now() };
});

canvas.addEventListener('pointerup', (event) => {
  if (!drag) return;
  const point = normalized(event);
  const distance = Math.hypot(point.x - drag.x, point.y - drag.y);
  if (distance < 0.015 && performance.now() - drag.at < 600) send({ type: 'tap', ...point });
  else send({ type: 'swipe', x1: drag.x, y1: drag.y, x2: point.x, y2: point.y, duration: 240 });
  drag = null;
});

canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const point = normalized(event);
    send({
      type: 'scroll',
      ...point,
      scrollX: Math.min(1, Math.max(-1, event.deltaX / 120)),
      scrollY: Math.min(1, Math.max(-1, event.deltaY / 120)),
    });
  },
  { passive: false },
);

canvas.tabIndex = 0;
canvas.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey) {
    if (['c', 'v', 'x', 'a'].includes(event.key.toLowerCase())) return;
  }
  const special = {
    Enter: 'enter',
    Backspace: 'backspace',
    Delete: 'delete',
    Tab: 'tab',
    Escape: 'escape',
    ArrowUp: 'arrowup',
    ArrowDown: 'arrowdown',
    ArrowLeft: 'arrowleft',
    ArrowRight: 'arrowright',
  }[event.key];
  event.preventDefault();
  if (special) send({ type: 'key', name: special });
  else if (event.key.length === 1) send({ type: 'text', text: event.key });
});

/* ------------------------------------------------------------------ wiring */

function wire() {
  $('run-button').addEventListener('click', start);
  $('stop-button').addEventListener('click', stop);
  $('clear-button').addEventListener('click', clear);
  $('error-dismiss').addEventListener('click', () => error(''));
  $('goal').addEventListener('input', renderActivity);
  $('goal').addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      start();
    }
  });
  for (const button of document.querySelectorAll('.rail-button')) {
    button.addEventListener('click', () => setPanel(button.dataset.panel));
  }
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => setPanel(tab.dataset.tab));
  }
  $('nav-back').addEventListener('click', () => send({ type: 'key', name: 'back' }));
  $('nav-home').addEventListener('click', () => send({ type: 'key', name: 'home' }));
  $('nav-recent').addEventListener('click', () => send({ type: 'key', name: 'appswitch' }));
  let screenOn = true;
  $('nav-power').addEventListener('click', () => {
    screenOn = !screenOn;
    send({ type: 'power', on: screenOn });
  });
  $('expand-button').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else $('device-stage').requestFullscreen();
  });
  $('reconnect-button').addEventListener('click', () => {
    location.reload();
  });

  const suggestionHost = $('suggestions');
  suggestionHost.innerHTML = EXAMPLES.map(
    (example) =>
      `<button data-goal="${escapeHtml(example.goal)}">${escapeHtml(example.label)} ↗</button>`,
  ).join('');
  for (const button of suggestionHost.querySelectorAll('[data-goal]')) {
    button.addEventListener('click', () => {
      $('goal').value = button.dataset.goal;
      $('goal').focus();
      renderActivity();
    });
  }

  setInterval(() => {
    if (!isActive(state.run)) return;
    state.now = Date.now();
    renderTelemetry();
  }, 60);
}

async function boot() {
  wire();
  renderAll();
  connect();
  try {
    state.device = await api('/api/device');
    $('device-name').textContent = `${state.device.name} · ${state.device.transport}`;
    $('stage-transport').textContent =
      `ANDROID · ${state.device.screen.width}×${state.device.screen.height}`;
    if (!state.device.hasModelKey)
      error('TYPESAFE_API_KEY is not set on the server: tasks cannot start yet.');
  } catch (failure) {
    setConnection('offline');
    $('stream-error-text').textContent = failure.message;
  }
  try {
    const runs = await api('/api/runs');
    if (Array.isArray(runs) && runs.length) {
      state.runs = runs;
      selectRun(runs[0]);
      if (isActive(runs[0])) subscribe(runs[0].id);
    }
  } catch {
    /* History is optional. */
  }
}

boot();
