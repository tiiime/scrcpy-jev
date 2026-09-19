import { setTimeout as delay } from 'node:timers/promises';

export function prepareInputVerification(observation, action) {
  // Replacing a readable field has an exact expected value. Appends may insert at an
  // unknown cursor position, so those are not verified locally.
  if (action.type !== 'type' || action.clear !== true) return null;
  const target = observation.elements.find(
    (element) => element.id === observation.phone.inputElementId,
  );
  if (!target?.editable || !target.enabled || target.password) return null;
  return {
    deviceId: observation.deviceId,
    packageName: observation.phone.packageName,
    target: {
      id: target.id,
      resourceId: target.resourceId,
      hint: target.hint,
      bounds: target.bounds,
    },
    text: action.text,
  };
}

export function inputMatches(observation, verification) {
  if (
    observation.deviceId !== verification.deviceId ||
    observation.phone.packageName !== verification.packageName
  )
    return false;
  const inputs = observation.elements.filter((e) => e.editable && e.enabled && !e.password);
  const { target } = verification;
  let candidates;
  if (target.resourceId) {
    candidates = inputs.filter((element) => element.resourceId === target.resourceId);
    if (candidates.length > 1)
      candidates = candidates.filter((element) => element.id === target.id);
  } else {
    // No stable resource ID: require the original tree position, hint and bounds.
    candidates = inputs.filter(
      (element) =>
        element.id === target.id &&
        element.hint === target.hint &&
        JSON.stringify(element.bounds) === JSON.stringify(target.bounds),
    );
  }
  return candidates.length === 1 && candidates[0].text === verification.text;
}

export async function confirmInput({
  initial,
  verification,
  observe,
  timeoutMs = 2500,
  pollMs = 40,
  sleep = delay,
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(pollMs) || pollMs < 1)
    throw new Error('Invalid input verification timing.');
  const deadline = performance.now() + timeoutMs;
  let observation = initial;
  while (!inputMatches(observation, verification)) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return { verified: false, observation };
    await sleep(Math.min(pollMs, remaining));
    observation = await observe();
  }
  return { verified: true, observation };
}
