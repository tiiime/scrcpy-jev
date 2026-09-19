// Turns the helper's raw accessibility dump into the observation shape the agent reasons about.
//
// The shape is deliberately the same one a cloud device API would return: a flat, stable list of
// addressable elements plus a small amount of phone state. Keeping it stable means the policy and
// the executor never need to know how the tree was produced.
import { createHash } from 'node:crypto';

const EDITABLE_CLASSES = new Set([
  'android.widget.EditText',
  'android.widget.AutoCompleteTextView',
  'android.widget.MultiAutoCompleteTextView',
  'androidx.appcompat.widget.AppCompatEditText',
  'com.google.android.material.textfield.TextInputEditText',
]);

// Some platforms stringify a missing content description instead of omitting it.
function clean(value) {
  const text = typeof value === 'string' ? value : '';
  return text === 'null' ? '' : text;
}

export function summarizeState(raw, deviceId) {
  const screen = {
    width: raw?.screen?.width,
    height: raw?.screen?.height,
    rotation: raw?.screen?.rotation ?? 0,
  };
  if (
    !Number.isSafeInteger(screen.width) ||
    !Number.isSafeInteger(screen.height) ||
    screen.width < 1 ||
    screen.height < 1 ||
    !Array.isArray(raw?.nodes)
  )
    throw new Error('The device observation is missing its element tree or valid screen bounds.');

  const elements = [];
  for (const node of raw.nodes) {
    const box = node.bounds;
    if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) continue;
    const bounds = {
      left: Math.max(0, box[0]),
      top: Math.max(0, box[1]),
      right: Math.min(screen.width, box[2]),
      bottom: Math.min(screen.height, box[3]),
    };
    if (node.visible === false || bounds.right <= bounds.left || bounds.bottom <= bounds.top)
      continue;
    const password = node.password === true;
    const text = password ? '[password]' : clean(node.text);
    const label = password ? '' : clean(node.label);
    const editable = node.editable === true || EDITABLE_CLASSES.has(node.className);
    if (!text && !label && !clean(node.hint) && !node.clickable && !editable && !node.scrollable)
      continue;
    elements.push({
      id: String(node.path),
      text,
      label,
      resourceId: clean(node.resourceId),
      hint: clean(node.hint),
      bounds,
      clickable: node.clickable === true,
      editable,
      scrollable: node.scrollable === true,
      enabled: node.enabled !== false,
      focused: node.focused === true,
      password,
      checkable: node.checkable === true,
      checked: node.checked === true,
      selected: node.selected === true,
    });
  }

  const inputs = elements.filter((element) => element.editable && element.enabled);
  const focusedInputs = inputs.filter((element) => element.focused);
  // A single visible field with the keyboard up is unambiguous even before focus is reported.
  const input =
    focusedInputs.length === 1
      ? focusedInputs[0]
      : raw.keyboardVisible && inputs.length === 1
        ? inputs[0]
        : undefined;
  const focusedElement = raw.nodes.find((node) => node.focused === true);
  const phone = {
    packageName: clean(raw.packageName),
    currentApp: clean(raw.packageName),
    isEditable: raw.isEditable === true || Boolean(input),
    inputElementId: input?.id,
    focusEvidence: raw.focusedEditable
      ? 'focused-node'
      : input?.focused
        ? 'focused-node'
        : input
          ? 'single-input-with-keyboard'
          : 'none',
    keyboardVisible: raw.keyboardVisible === true,
    focusedElement: {
      resourceId: clean(focusedElement?.resourceId),
      className: clean(focusedElement?.className),
    },
  };
  const content = { deviceId, phone, screen, elements };
  return {
    ...content,
    fingerprint: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
    observedAt: Date.now(),
  };
}

/** A small, cloneable description of an observation, for step records and traces. */
export function observationSummary(observation) {
  return {
    deviceId: observation.deviceId,
    packageName: observation.phone.packageName,
    screen: observation.screen,
    isEditable: observation.phone.isEditable,
    keyboardVisible: observation.phone.keyboardVisible,
    inputElementId: observation.phone.inputElementId || null,
    elements: observation.elements.length,
    fingerprint: observation.fingerprint,
    observedAt: observation.observedAt,
  };
}
