import { randomUUID } from 'node:crypto';

export class StudioError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const ACTIVE = new Set(['running', 'stopping']);
const TIMELINE_TYPES = new Set(['decision', 'action', 'result', 'error']);
// Step records (full model requests and responses) are kept outside the run object so that
// server-sent events stay small, and capped so a long run cannot grow without bound.
const MAX_STEP_BYTES = 24 * 1024 * 1024;
const MAX_STEP_ENTRY_BYTES = 512 * 1024;

export function createStore({ now = Date.now, runner, maxRuns = 30 } = {}) {
  if (typeof runner !== 'function') throw new StudioError('A task runner is required.', 500);
  const runs = new Map();
  const listeners = new Map();
  const controls = new Map();
  const steps = new Map();
  const stepBytes = new Map();

  const sizeOf = (value) => {
    try {
      return JSON.stringify(value).length;
    } catch {
      return 0;
    }
  };
  const remember = (id, step, payload) => {
    // The runner already guards its payloads; the store enforces its own bound because it owns the
    // memory either way.
    if (sizeOf(payload) > MAX_STEP_ENTRY_BYTES)
      payload = {
        truncated: true,
        reason: `step record exceeded ${MAX_STEP_ENTRY_BYTES} bytes`,
      };
    if (!steps.has(id)) steps.set(id, new Map());
    if (!stepBytes.has(id)) stepBytes.set(id, new Map());
    const byStep = steps.get(id);
    const sizes = stepBytes.get(id);
    const key = Number.isInteger(step) ? step : 'final';
    const merged = { ...(byStep.get(key) || {}), ...payload };
    byStep.set(key, merged);
    sizes.set(key, sizeOf(merged));
    let total = [...sizes.values()].reduce((sum, value) => sum + value, 0);
    // Drop the oldest records first: recent steps are the ones being debugged.
    for (const oldest of [...byStep.keys()]) {
      if (total <= MAX_STEP_BYTES) break;
      if (oldest === key) continue;
      total -= sizes.get(oldest) || 0;
      byStep.delete(oldest);
      sizes.delete(oldest);
    }
  };
  const forget = (id) => {
    steps.delete(id);
    stepBytes.delete(id);
  };
  const snapshot = (id) => (runs.get(id) ? structuredClone(runs.get(id)) : null);
  // Numeric steps come from the URL as strings; the final step record uses the 'final' key.
  const stepRecord = (id, step) => {
    const key = /^\d+$/.test(String(step)) ? Number(step) : String(step);
    const record = steps.get(id)?.get(key);
    return record ? structuredClone(record) : null;
  };
  const publish = (id) => {
    for (const callback of listeners.get(id) || []) {
      try {
        callback(snapshot(id));
      } catch {
        listeners.get(id)?.delete(callback);
      }
    }
  };
  const active = () => [...runs.values()].find((run) => ACTIVE.has(run.status));

  return {
    list: () => [...runs.values()].reverse().map((run) => snapshot(run.id)),
    get: snapshot,
    step: stepRecord,
    steps: (id) => [...(steps.get(id)?.keys() ?? [])],
    active,
    clear() {
      if (active()) throw new StudioError('Stop the active task before clearing recent runs.', 409);
      const cleared = runs.size;
      for (const id of runs.keys()) forget(id);
      runs.clear();
      listeners.clear();
      return { cleared };
    },
    subscribe(id, callback) {
      if (!runs.has(id)) throw new StudioError('Run not found.', 404);
      if (!listeners.has(id)) listeners.set(id, new Set());
      listeners.get(id).add(callback);
      return () => {
        listeners.get(id)?.delete(callback);
      };
    },
    start({ goal, maxSteps = 30 }) {
      if (typeof goal !== 'string' || !goal.trim() || goal.length > 4000)
        throw new StudioError('Enter a goal between 1 and 4,000 characters.');
      if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 50)
        throw new StudioError('The step limit must be between 1 and 50.');
      if (active()) throw new StudioError('A task is already running on this device.', 409);
      while (runs.size >= maxRuns) {
        const id = runs.keys().next().value;
        runs.delete(id);
        listeners.delete(id);
        forget(id);
      }
      const id = randomUUID();
      const run = {
        id,
        goal: goal.trim(),
        maxSteps,
        status: 'running',
        startedAt: now(),
        endedAt: null,
        events: [],
        outcome: null,
        error: null,
      };
      runs.set(id, run);
      const control = { stopped: false };
      controls.set(id, control);
      const finish = (status, message) => {
        if (run.endedAt !== null) return;
        run.status = status;
        run.endedAt = now();
        if (message) run.error = message;
        controls.delete(id);
        publish(id);
      };
      const emit = (event) => {
        if (run.endedAt !== null) return;
        const { detail, ...summary } = event;
        if (detail !== undefined) remember(id, event.step, detail);
        // 'detail' events (observations) only enrich the step record; they never reach the timeline.
        if (!TIMELINE_TYPES.has(event.type)) return;
        run.events.push({ ...summary, sequence: run.events.length });
        if (event.type === 'result') run.outcome = event.outcome;
        if (event.type === 'error') run.error = event.message;
        publish(id);
      };
      // Runs in process: the scrcpy session that owns the phone cannot be opened twice.
      runner({
        goal: run.goal,
        maxSteps,
        emit,
        shouldStop: () => control.stopped,
      })
        .then((outcome) => {
          if (run.status === 'stopping') finish('stopped');
          else if (outcome === 'cancelled') finish('stopped');
          else if (!run.outcome && !run.error) finish('failed', 'The task ended unexpectedly.');
          else finish(run.outcome === 'done' ? 'succeeded' : 'blocked');
        })
        .catch((error) => {
          if (run.status === 'stopping' || error?.name === 'CancelledError') finish('stopped');
          else finish('failed', error?.message || 'The task failed.');
        });
      return snapshot(id);
    },
    stop(id) {
      const run = runs.get(id);
      if (!run) throw new StudioError('Run not found.', 404);
      if (run.endedAt !== null) return snapshot(id);
      run.status = 'stopping';
      const control = controls.get(id);
      if (control) control.stopped = true;
      publish(id);
      return snapshot(id);
    },
  };
}
