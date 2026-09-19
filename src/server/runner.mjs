// Glue between the studio's run store and the agent loop.
//
// The store hands the runner a single-argument `emit(event)`; getting that shape wrong silently
// drops every event, so this module is kept separate and covered by test/runner.test.mjs.
//
// Each event may carry a `detail` payload. The store keeps those out of band, keyed by step, so the
// activity feed stays small while every step remains fully inspectable on demand.
import { runAgent } from '../agent/agent.mjs';

// A single step must never be able to exhaust server memory: the request can be ~150 KB by design.
const MAX_DETAIL_BYTES = 512 * 1024;

export function createStudioRunner({ device, policy, run = runAgent }) {
  return async function runner({ goal, maxSteps, emit, shouldStop }) {
    const detail = (payload) => {
      try {
        return JSON.stringify(payload).length > MAX_DETAIL_BYTES
          ? { truncated: true, reason: `step record exceeded ${MAX_DETAIL_BYTES} bytes` }
          : payload;
      } catch {
        return { truncated: true, reason: 'step record was not serialisable' };
      }
    };

    const result = await run({
      device,
      policy,
      goal,
      maxSteps,
      execute: true,
      shouldStop,
      onStep: (decision) =>
        emit({
          type: 'decision',
          step: decision.step,
          attempt: decision.attempt,
          status: decision.status,
          operation: decision.operation,
          label: decision.label,
          confidence: decision.confidence,
          targetConfidence: decision.targetConfidence,
          latencyMs: decision.latencyMs,
          model: decision.responseModel,
          reason: decision.reason,
          detail: detail({
            request: decision.request ?? null,
            response: decision.response ?? null,
            decision: {
              status: decision.status,
              operation: decision.operation,
              target: decision.target ?? null,
              choice: decision.choice ?? null,
              confidence: decision.confidence,
              targetConfidence: decision.targetConfidence ?? null,
              reason: decision.reason ?? null,
              requestedModel: decision.requestedModel ?? null,
              responseModel: decision.responseModel ?? null,
              latencyMs: decision.latencyMs ?? null,
              usage: decision.usage ?? null,
            },
          }),
        }),
      onAction: (event) =>
        emit({
          type: 'action',
          step: event.step,
          operation: event.operation,
          label: event.label,
          executedMs: event.executedMs,
          detail: detail({
            execution: {
              action: event.action,
              executed: event.receipt?.executed ?? null,
              verified: Boolean(event.receipt?.inputVerification),
              executedMs: event.executedMs,
            },
            before: event.before ?? null,
          }),
        }),
      // Observation updates only enrich the step record; they are never timeline entries.
      onObservation: (event) =>
        emit({
          type: 'detail',
          step: event.step,
          detail: { after: event.summary ?? null, screenChanged: event.screenChanged },
        }),
    });

    emit({
      type: 'result',
      outcome: result.status,
      steps: result.steps,
      timings: result.timings,
      reason: result.decision?.reason,
      detail: detail({
        outcome: result.status,
        timings: result.timings,
        decision: result.decision
          ? {
              status: result.decision.status,
              operation: result.decision.operation ?? null,
              reason: result.decision.reason ?? null,
            }
          : null,
      }),
    });
    return result.status;
  };
}
