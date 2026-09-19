// Thin ADB helpers shared by every other module.
//
// Everything local goes through the ADB *server* socket, so no `adb` process has to be forked
// per command: the same connection also carries `exec:` streams and abstract sockets.
import { AdbServerClient } from '@yume-chan/adb';
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp';
import { escapeArg } from '@yume-chan/adb';

export class AdbUnavailableError extends Error {}

export function adbServer({ host = '127.0.0.1', port = 5037 } = {}) {
  return new AdbServerClient(new AdbServerNodeTcpConnector({ host, port }));
}

export async function listDevices(server) {
  const devices = await server.getDevices();
  return devices.map((device) => ({
    serial: device.serial,
    model: device.model || '',
    product: device.product || '',
    state: device.state,
    connected: device.state === 'device',
  }));
}

/**
 * Picks the requested device (or the only connected one) and opens an ADB session for it.
 */
export async function connectDevice({ host, port, serial } = {}) {
  const server = adbServer({ host, port });
  let devices;
  try {
    devices = await listDevices(server);
  } catch (error) {
    throw new AdbUnavailableError(
      `Could not reach the ADB server on ${host}:${port}. Start it with "adb start-server". (${error.message})`,
    );
  }
  if (!devices.length)
    throw new AdbUnavailableError(
      'No Android device is connected. Enable USB debugging and retry.',
    );
  const ready = devices.filter((device) => device.connected);
  if (!ready.length) {
    const states = devices.map((device) => `${device.serial} (${device.state})`).join(', ');
    throw new AdbUnavailableError(`No device is ready: ${states}.`);
  }
  const chosen = serial
    ? ready.find((device) => device.serial === serial)
    : ready.length === 1
      ? ready[0]
      : null;
  if (!chosen)
    throw new AdbUnavailableError(
      serial
        ? `Device ${serial} is not connected. Available: ${ready.map((d) => d.serial).join(', ')}.`
        : `Several devices are connected; pass --device or set ANDROID_SERIAL: ${ready
            .map((d) => d.serial)
            .join(', ')}.`,
    );
  const adb = await server.createAdb({ serial: chosen.serial });
  return { adb, server, device: chosen };
}

/** Runs a command through the device shell and returns stdout (stderr is merged by `exec:`). */
export async function shell(adb, args, { binary = false } = {}) {
  const command = (Array.isArray(args) ? args : [args]).map(escapeArg).join(' ');
  return binary
    ? adb.subprocess.noneProtocol.spawnWait(command)
    : adb.subprocess.noneProtocol.spawnWaitText(command);
}

export async function getProp(adb, key) {
  return (await shell(adb, ['getprop', key])).trim();
}

export async function isReady(adb) {
  const [boot, display] = await Promise.all([
    getProp(adb, 'sys.boot_completed'),
    shell(adb, ['wm', 'size']).catch(() => ''),
  ]);
  return { booted: boot === '1', hasDisplay: /size:\s*\d+x\d+/i.test(display) };
}

/** Reads a PNG frame straight from `screencap`, bypassing the accessibility layer. */
export async function screencap(adb) {
  const bytes = Buffer.from(await shell(adb, ['screencap', '-p'], { binary: true }));
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Error('The device did not return a PNG screenshot.');
  return bytes;
}

export { escapeArg };
