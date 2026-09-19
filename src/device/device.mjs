// The local device adapter: scrcpy for input, an accessibility dump for state, ADB for everything
// else. It exposes the same surface a cloud device API would, so the agent never learns where it
// runs.
import { setTimeout as delay } from 'node:timers/promises';
import {
  AndroidKeyCode,
  AndroidKeyEventAction,
  AndroidKeyEventMeta,
  AndroidMotionEventAction,
  AndroidMotionEventButton,
  ScrcpyPointerId,
} from '@yume-chan/scrcpy';
import { getProp, isReady, screencap, shell } from './adb.mjs';
import { listApps, isInstalled } from './apps.mjs';
import { prepareInputVerification } from '../agent/input-verification.mjs';
import { summarizeState } from './summarize.mjs';

export const GLOBAL_KEYS = {
  back: AndroidKeyCode.AndroidBack,
  home: AndroidKeyCode.AndroidHome,
  recent: AndroidKeyCode.AndroidAppSwitch,
};

export const KEYS = {
  back: AndroidKeyCode.AndroidBack,
  tab: AndroidKeyCode.Tab,
  enter: AndroidKeyCode.Enter,
  delete: AndroidKeyCode.Backspace,
  forward_delete: AndroidKeyCode.Delete,
};

export class StaleObservationError extends Error {}

function integer(value, name, min = 0) {
  if (!Number.isSafeInteger(value) || value < min)
    throw new Error(`${name} must be an integer >= ${min}.`);
}

function targetMeaning(observation, id) {
  const target = observation.elements.find((element) => element.id === id);
  if (!target) return null;
  const meaning = Object.fromEntries(Object.entries(target).filter(([key]) => key !== 'bounds'));
  return JSON.stringify({
    ...meaning,
    content: observation.elements
      .filter((element) => element.id.startsWith(id + '.'))
      .map(({ id, text, label, resourceId, editable, enabled, checked, selected }) => ({
        id,
        text,
        label,
        resourceId,
        editable,
        enabled,
        checked,
        selected,
      })),
  });
}

/**
 * Refuses to dispatch input that was chosen for a screen which has since changed. A stale decision
 * is never retried silently: the loop observes again and asks the policy for a fresh choice.
 */
export function assertFresh(current, expected, action, maxAgeMs = 30_000) {
  if (
    !expected ||
    current.deviceId !== expected.deviceId ||
    !Number.isFinite(expected.observedAt) ||
    Date.now() - expected.observedAt > maxAgeMs ||
    expected.observedAt > Date.now() ||
    current.phone.packageName !== expected.phone?.packageName ||
    JSON.stringify(current.screen) !== JSON.stringify(expected.screen)
  )
    throw new StaleObservationError(
      'Screen changed or observation expired; observe and decide again.',
    );
  let fresh;
  if (action.type === 'tap-element') {
    fresh =
      targetMeaning(expected, action.elementId) !== null &&
      targetMeaning(current, action.elementId) === targetMeaning(expected, action.elementId);
  } else if (['type', 'clear', 'key'].includes(action.type) && expected.phone.inputElementId) {
    const id = expected.phone.inputElementId;
    fresh =
      current.phone.isEditable &&
      current.phone.inputElementId === id &&
      targetMeaning(current, id) === targetMeaning(expected, id);
  } else if (action.type === 'global' && action.name === 'home') {
    fresh = true; // HOME is independent of in-app content such as clocks and animations.
  } else if (action.type === 'global') {
    const navigationMeaning = (state) =>
      JSON.stringify({
        phone: state.phone,
        controls: state.elements
          .filter((element) => element.clickable || element.editable)
          .map((element) => targetMeaning(state, element.id)),
        headings: state.elements
          .filter((element) => element.resourceId?.endsWith(':id/title') || element.label)
          .map((element) => [element.id, element.text, element.label]),
      });
    fresh = navigationMeaning(current) === navigationMeaning(expected);
  } else if (action.type === 'swipe' && action.regionId) {
    const before = expected.elements.find((element) => element.id === action.regionId);
    const after = current.elements.find((element) => element.id === action.regionId);
    fresh = before && after?.enabled && after.scrollable && before.resourceId === after.resourceId;
  } else {
    fresh = current.fingerprint === expected.fingerprint;
  }
  if (!fresh)
    throw new StaleObservationError(
      'Screen changed or observation expired; observe and decide again.',
    );
}

export class ScrcpyDevice {
  /**
   * @param {object} init
   * @param {import('@yume-chan/adb').Adb} init.adb
   * @param {import('./helper.mjs').JevHelper} init.helper
   * @param {import('./scrcpy-session.mjs').ScrcpySession} [init.session] control channel
   * @param {{serial: string, model?: string}} init.device
   */
  constructor({ adb, helper, session = null, device, refreshHelper = null }) {
    this.adb = adb;
    this.helper = helper;
    this.session = session;
    // Set by the runtime: re-ensures a live helper after idle retirement or a device-side restart.
    this.refreshHelper = refreshHelper;
    this.deviceId = device.serial;
    this.deviceName = device.model || device.serial;
    this.installedApps = [];
    this.readyAt = -Infinity;
    this.screen = null;
  }

  static async open({ adb, helper, session, device }) {
    return new ScrcpyDevice({ adb, helper, session, device });
  }

  attachSession(session) {
    this.session = session;
  }

  #controller() {
    const controller = this.session?.controller;
    if (!controller) throw new Error('The scrcpy control channel is not connected.');
    return controller;
  }

  async assertReady() {
    const status = await isReady(this.adb);
    if (!status.booted) throw new Error('The device has not finished booting.');
    if (!status.hasDisplay) throw new Error('The device reports no active display.');
    this.readyAt = performance.now();
    this.model = await getProp(this.adb, 'ro.product.model').catch(() => this.deviceName);
    return { id: this.deviceId, name: this.model || this.deviceName, state: 'ready' };
  }

  async listApps() {
    this.installedApps = await listApps(this.adb);
    return this.installedApps;
  }

  /**
   * Reading the screen is idempotent, so a broken helper connection is repaired and retried once.
   * Mutations are never retried this way.
   */
  async observe() {
    try {
      return this.#summarize(await this.helper.dump());
    } catch (error) {
      if (!this.refreshHelper) throw error;
      this.helper = await this.refreshHelper();
      return this.#summarize(await this.helper.dump());
    }
  }

  #summarize(raw) {
    const observation = summarizeState(raw, this.deviceId);
    this.screen = observation.screen;
    return observation;
  }

  async screenshot() {
    return screencap(this.adb);
  }

  /** Maps device pixels onto the (possibly downscaled) scrcpy video surface. */
  #toVideo(x, y) {
    const width = this.session?.width || this.screen?.width || 0;
    const height = this.session?.height || this.screen?.height || 0;
    const scaleX = width && this.screen?.width ? width / this.screen.width : 1;
    const scaleY = height && this.screen?.height ? height / this.screen.height : 1;
    return {
      x: Math.round(x * scaleX),
      y: Math.round(y * scaleY),
      videoWidth: width || this.screen?.width || 0,
      videoHeight: height || this.screen?.height || 0,
    };
  }

  async #touch(action, x, y, { pressure = 1 } = {}) {
    const point = this.#toVideo(x, y);
    await this.#controller().injectTouch({
      action,
      pointerId: ScrcpyPointerId.Finger,
      pointerX: point.x,
      pointerY: point.y,
      videoWidth: point.videoWidth,
      videoHeight: point.videoHeight,
      pressure,
      actionButton: AndroidMotionEventButton.Primary,
      buttons: AndroidMotionEventButton.Primary,
    });
  }

  async #tap(x, y) {
    await this.#touch(AndroidMotionEventAction.Down, x, y);
    await delay(40);
    await this.#touch(AndroidMotionEventAction.Up, x, y, { pressure: 0 });
  }

  async #swipe(startX, startY, endX, endY, duration = 300) {
    const steps = Math.max(4, Math.min(24, Math.round(duration / 16)));
    await this.#touch(AndroidMotionEventAction.Down, startX, startY);
    for (let step = 1; step <= steps; step++) {
      const fraction = step / steps;
      await this.#touch(
        AndroidMotionEventAction.Move,
        Math.round(startX + (endX - startX) * fraction),
        Math.round(startY + (endY - startY) * fraction),
      );
      await delay(Math.max(1, Math.round(duration / steps)));
    }
    await this.#touch(AndroidMotionEventAction.Up, endX, endY, { pressure: 0 });
  }

  async #key(keyCode) {
    const controller = this.#controller();
    await controller.injectKeyCode({
      action: AndroidKeyEventAction.Down,
      keyCode,
      repeat: 0,
      metaState: 0,
    });
    await controller.injectKeyCode({
      action: AndroidKeyEventAction.Up,
      keyCode,
      repeat: 0,
      metaState: 0,
    });
  }

  /** Clears the focused field with select-all, which also works for password fields. */
  async #clear(observation) {
    const controller = this.#controller();
    await controller.injectKeyCode({
      action: AndroidKeyEventAction.Down,
      keyCode: AndroidKeyCode.KeyA,
      repeat: 0,
      metaState: AndroidKeyEventMeta.Ctrl,
    });
    await controller.injectKeyCode({
      action: AndroidKeyEventAction.Up,
      keyCode: AndroidKeyCode.KeyA,
      repeat: 0,
      metaState: AndroidKeyEventMeta.Ctrl,
    });
    await delay(60);
    await this.#key(AndroidKeyCode.Backspace);
    await delay(120);
    // Verify the field really emptied; some fields ignore Ctrl+A.
    const after = await this.observe();
    const target = after.elements.find((element) => element.id === after.phone.inputElementId);
    if (target && !target.password && target.text) {
      const deletes = Math.min(400, target.text.length + 1);
      for (let index = 0; index < deletes; index++) await this.#key(AndroidKeyCode.Backspace);
    }
    return observation;
  }

  async #type(text) {
    const controller = this.#controller();
    // scrcpy maps ASCII straight to key events. Anything else is pasted, which keeps Unicode and
    // emoji intact on IMEs that ignore synthesized key events.
    if (/^[\x20-\x7e\n\t]*$/.test(text)) {
      await controller.injectText(text);
      return;
    }
    await controller.setClipboard({ sequence: 0n, paste: true, content: text });
  }

  async act(action, { expected, maxAgeMs = 30_000 } = {}) {
    if (!action || typeof action !== 'object') throw new Error('An action object is required.');
    if (performance.now() - this.readyAt > 30_000) await this.assertReady();
    if (action.type === 'open-app') return this.#openApp(action, expected);
    const current = await this.observe();
    if (expected) assertFresh(current, expected, action, maxAgeMs);
    const point = (x, y) => {
      integer(x, 'x');
      integer(y, 'y');
      if (x >= current.screen.width || y >= current.screen.height)
        throw new Error('Coordinates are outside the screen.');
    };
    switch (action.type) {
      case 'tap':
        point(action.x, action.y);
        await this.#tap(action.x, action.y);
        await delay(120);
        return { executed: { type: 'tap', x: action.x, y: action.y } };
      case 'tap-element': {
        if (!expected) throw new Error('Element taps require their original observation.');
        const element = current.elements.find((entry) => entry.id === action.elementId);
        if (!element?.enabled || !(element.clickable || element.editable))
          throw new Error('Element is not actionable.');
        const { left, top, right, bottom } = element.bounds;
        const center = { x: Math.floor((left + right) / 2), y: Math.floor((top + bottom) / 2) };
        await this.#tap(center.x, center.y);
        await delay(120);
        return { executed: { type: 'tap-element', elementId: action.elementId, ...center } };
      }
      case 'swipe': {
        point(action.startX, action.startY);
        point(action.endX, action.endY);
        integer(action.duration ?? 300, 'duration', 10);
        let { startX, startY, endX, endY } = action;
        if (action.regionId && expected) {
          const before = expected.elements.find(
            (element) => element.id === action.regionId,
          )?.bounds;
          const after = current.elements.find((element) => element.id === action.regionId)?.bounds;
          if (!before || !after) throw new Error('The scroll region is no longer present.');
          // Resolve the same relative gesture in current geometry (e.g. a collapsing toolbar).
          const project = (value, oldStart, oldEnd, newStart, newEnd) => {
            const fraction = (value - oldStart) / (oldEnd - oldStart);
            if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1)
              throw new Error('Swipe leaves its observed region.');
            return Math.floor(newStart + fraction * (newEnd - newStart));
          };
          startX = project(startX, before.left, before.right, after.left, after.right);
          endX = project(endX, before.left, before.right, after.left, after.right);
          startY = project(startY, before.top, before.bottom, after.top, after.bottom);
          endY = project(endY, before.top, before.bottom, after.top, after.bottom);
          point(startX, startY);
          point(endX, endY);
        }
        await this.#swipe(startX, startY, endX, endY, action.duration ?? 300);
        await delay(150);
        return {
          executed: {
            type: 'swipe',
            startX,
            startY,
            endX,
            endY,
            duration: action.duration ?? 300,
            regionId: action.regionId,
          },
        };
      }
      case 'type': {
        if (!current.phone.isEditable) throw new Error('Focus an editable field before typing.');
        if (
          typeof action.text !== 'string' ||
          (action.clear !== undefined && typeof action.clear !== 'boolean')
        )
          throw new Error('Text must be a string and clear must be boolean.');
        const verification = prepareInputVerification(current, action);
        if (action.clear) await this.#clear(current);
        await this.#type(action.text);
        await delay(60);
        return {
          executed: {
            type: 'type',
            text: action.text,
            clear: Boolean(action.clear),
            method: /^[\x20-\x7e\n\t]*$/.test(action.text) ? 'key-events' : 'clipboard-paste',
            field: current.phone.inputElementId,
          },
          ...(verification ? { inputVerification: verification } : {}),
        };
      }
      case 'clear': {
        if (!current.phone.isEditable) throw new Error('Focus an editable field before clearing.');
        await this.#clear(current);
        return { executed: { type: 'clear', field: current.phone.inputElementId } };
      }
      case 'key': {
        if (!Object.hasOwn(KEYS, action.key)) throw new Error('Unsupported keyboard key.');
        await this.#key(KEYS[action.key]);
        await delay(80);
        return { executed: { type: 'key', key: action.key } };
      }
      case 'global': {
        if (!Object.hasOwn(GLOBAL_KEYS, action.name)) throw new Error('Unsupported global action.');
        await this.#key(GLOBAL_KEYS[action.name]);
        await delay(200);
        return { executed: { type: 'global', name: action.name } };
      }
      default:
        throw new Error('Unsupported action type.');
    }
  }

  async #openApp(action, expected) {
    if (expected && expected.deviceId !== this.deviceId)
      throw new Error('Observation belongs to a different device.');
    const installed =
      this.installedApps.some((app) => app.packageName === action.packageName) ||
      (await isInstalled(this.adb, action.packageName));
    if (!installed) throw new Error('The app was not observed in the installed-app list.');
    const controller = this.session?.controller;
    if (controller) {
      try {
        await controller.startApp(action.packageName, { forceStop: true });
        await delay(300);
        return { executed: { type: 'open-app', packageName: action.packageName, via: 'scrcpy' } };
      } catch {
        // Older servers expose no start-app message; fall back to the platform launcher.
      }
    }
    await shell(this.adb, [
      'monkey',
      '-p',
      action.packageName,
      '-c',
      'android.intent.category.LAUNCHER',
      '1',
    ]);
    await delay(300);
    return { executed: { type: 'open-app', packageName: action.packageName, via: 'am-monkey' } };
  }
}
