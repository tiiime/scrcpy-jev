// Assembles the pieces every entry point needs: an ADB session, the on-device observation helper
// and one scrcpy session shared by input injection and the live view.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { config as defaultConfig, root } from '../config.mjs';
import { connectDevice } from './adb.mjs';
import { JevHelper } from './helper.mjs';
import { ScrcpyDevice } from './device.mjs';
import { ScrcpySession } from './scrcpy-session.mjs';

/** Never let a wedged ADB socket keep the process alive during shutdown. */
async function settle(promise, ms = 3000) {
  try {
    await Promise.race([promise, delay(ms)]);
  } catch {
    // Closing is best effort: a device that vanished must not block exit.
  }
}

export const HELPER_JAR = join(root, 'src/device/helper/scrcpy-jev.jar');

async function ensureHelperJar({ onLog = () => {} } = {}) {
  if (existsSync(HELPER_JAR)) return HELPER_JAR;
  onLog('Building the on-device helper (first run only)…');
  const { buildHelper } = await import('../../scripts/build-helper.mjs');
  try {
    return buildHelper({ quiet: true });
  } catch (error) {
    throw new Error(
      `The on-device helper could not be built: ${error.message}\n` +
        'Install a JDK and the Android SDK build-tools, or run "npm run helper" after installing them.',
    );
  }
}

/**
 * @param {object} [options]
 * @param {ReturnType<typeof defaultConfig>} [options.config]
 * @param {boolean} [options.video] keep the scrcpy video stream open (studio)
 * @param {boolean} [options.control] inject input over scrcpy instead of ADB shell input
 * @param {(message: string) => void} [options.onLog]
 */
export async function openRuntime({
  config = defaultConfig(),
  video = true,
  control = true,
  onLog = () => {},
} = {}) {
  const { adb, device: target } = await connectDevice({
    host: config.adbHost,
    port: config.adbPort,
    serial: config.serial,
  });
  onLog(`Connected to ${target.serial}${target.model ? ` (${target.model})` : ''}.`);
  const jarPath = await ensureHelperJar({ onLog });
  const ensureHelper = () => JevHelper.ensure(adb, jarPath);
  const helper = await ensureHelper();
  let session = null;
  if (video || control) {
    session = await ScrcpySession.start(adb, {
      serverPath: config.scrcpyServerPath,
      scrcpyPath: config.scrcpyPath,
      version: config.scrcpyVersion,
      video: config.video,
    });
    onLog(
      `scrcpy ${session.metadata?.deviceName || target.serial} streaming ${session.width}×${session.height}.`,
    );
  }
  const device = new ScrcpyDevice({
    adb,
    helper,
    session,
    device: target,
    refreshHelper: async () => {
      onLog('Reconnecting to the on-device helper…');
      return ensureHelper();
    },
  });
  let closing = null;
  return {
    adb,
    helper,
    session,
    device,
    target,
    close() {
      closing ??= (async () => {
        await settle(Promise.resolve(session?.close()), 3000);
        await settle(Promise.resolve(helper.close()), 2000);
        await settle(adb.close(), 2000);
      })();
      return closing;
    },
  };
}
