// Browser-to-device input: the studio forwards pointer and keyboard events into the same scrcpy
// control channel the agent uses, so a human can always take over.
import {
  AndroidKeyCode,
  AndroidKeyEventAction,
  AndroidKeyEventMeta,
  AndroidMotionEventAction,
  AndroidMotionEventButton,
  ScrcpyPointerId,
} from '@yume-chan/scrcpy';

const KEYS = {
  enter: AndroidKeyCode.Enter,
  backspace: AndroidKeyCode.Backspace,
  delete: AndroidKeyCode.Delete,
  tab: AndroidKeyCode.Tab,
  escape: AndroidKeyCode.Escape,
  arrowup: AndroidKeyCode.ArrowUp,
  arrowdown: AndroidKeyCode.ArrowDown,
  arrowleft: AndroidKeyCode.ArrowLeft,
  arrowright: AndroidKeyCode.ArrowRight,
  home: AndroidKeyCode.AndroidHome,
  back: AndroidKeyCode.AndroidBack,
  appswitch: AndroidKeyCode.AndroidAppSwitch,
  power: AndroidKeyCode.Power,
  volumeup: AndroidKeyCode.VolumeUp,
  volumedown: AndroidKeyCode.VolumeDown,
};

const META = {
  shift: AndroidKeyEventMeta.Shift,
  ctrl: AndroidKeyEventMeta.Ctrl,
  alt: AndroidKeyEventMeta.Alt,
  meta: AndroidKeyEventMeta.Meta,
};

export class InputChannel {
  /**
   * @param {object} init
   * @param {import('../device/scrcpy-session.mjs').ScrcpySession} init.session
   * @param {() => {width: number, height: number}} init.surface device pixel size
   * @param {() => boolean} [init.locked] true while the agent owns the device
   */
  constructor({ session, surface, locked = () => false }) {
    this.session = session;
    this.surface = surface;
    this.locked = locked;
  }

  #controller() {
    const controller = this.session?.controller;
    if (!controller) throw new Error('The scrcpy control channel is not connected.');
    return controller;
  }

  #video() {
    return {
      width: this.session?.metadata?.width || 0,
      height: this.session?.metadata?.height || 0,
    };
  }

  #deny() {
    if (this.locked()) throw new Error('The agent is driving the device right now.');
  }

  #point(x, y) {
    const { width, height } = this.surface();
    return {
      x: Math.round(Math.min(1, Math.max(0, x)) * width),
      y: Math.round(Math.min(1, Math.max(0, y)) * height),
    };
  }

  async #touch(action, x, y, pressure = 1) {
    const point = this.#point(x, y);
    const video = this.#video();
    await this.#controller().injectTouch({
      action,
      pointerId: ScrcpyPointerId.Mouse,
      pointerX: point.x,
      pointerY: point.y,
      videoWidth: video.width,
      videoHeight: video.height,
      pressure,
      actionButton: AndroidMotionEventButton.Primary,
      buttons: action === AndroidMotionEventAction.Up ? 0 : AndroidMotionEventButton.Primary,
    });
    return point;
  }

  async tap({ x, y }) {
    this.#deny();
    await this.#touch(AndroidMotionEventAction.Down, x, y);
    await this.#touch(AndroidMotionEventAction.Up, x, y, 0);
  }

  async swipe({ x1, y1, x2, y2, duration = 260 }) {
    this.#deny();
    const steps = Math.max(6, Math.min(28, Math.round(duration / 16)));
    await this.#touch(AndroidMotionEventAction.Down, x1, y1);
    for (let step = 1; step <= steps; step++) {
      const fraction = step / steps;
      await this.#touch(
        AndroidMotionEventAction.Move,
        x1 + (x2 - x1) * fraction,
        y1 + (y2 - y1) * fraction,
      );
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(1, Math.round(duration / steps))),
      );
    }
    await this.#touch(AndroidMotionEventAction.Up, x2, y2, 0);
  }

  async scroll({ x, y, scrollX = 0, scrollY = 0 }) {
    this.#deny();
    const point = this.#point(x, y);
    const video = this.#video();
    await this.#controller().injectScroll({
      pointerX: point.x,
      pointerY: point.y,
      videoWidth: video.width,
      videoHeight: video.height,
      scrollX: Math.min(1, Math.max(-1, scrollX)),
      scrollY: Math.min(1, Math.max(-1, scrollY)),
      buttons: 0,
    });
  }

  async text({ text }) {
    this.#deny();
    if (typeof text !== 'string' || text.length > 800) throw new Error('Unsupported text input.');
    const controller = this.#controller();
    if (/^[\x20-\x7e\n\t]*$/.test(text)) await controller.injectText(text);
    else await controller.setClipboard({ sequence: 0n, paste: true, content: text });
  }

  async key({ name, modifiers = [] }) {
    this.#deny();
    const keyCode = KEYS[String(name).toLowerCase()];
    if (keyCode === undefined) throw new Error('Unsupported key.');
    const metaState = modifiers.reduce((state, modifier) => state | (META[modifier] || 0), 0);
    const controller = this.#controller();
    await controller.injectKeyCode({
      action: AndroidKeyEventAction.Down,
      keyCode,
      repeat: 0,
      metaState,
    });
    await controller.injectKeyCode({
      action: AndroidKeyEventAction.Up,
      keyCode,
      repeat: 0,
      metaState,
    });
  }

  async power({ on }) {
    this.#deny();
    await this.#controller().setScreenPowerMode(on ? 0 : 2);
  }
}

export function parseInputCommand(message) {
  if (!message || typeof message !== 'object') throw new Error('Invalid input message.');
  const type = String(message.type || '');
  if (!['tap', 'swipe', 'scroll', 'text', 'key', 'power'].includes(type))
    throw new Error('Invalid input message.');
  return { ...message, type };
}
