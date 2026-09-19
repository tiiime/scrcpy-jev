// Owns the single scrcpy session used for both the live view (video) and device input (control).
//
// The scrcpy server jar is the one shipped with the locally installed scrcpy release, so the
// protocol version always matches. `@yume-chan/scrcpy` provides the on-device server plumbing and
// the control-message encoders.
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as AdbScrcpy from '@yume-chan/adb-scrcpy';
import { DefaultServerPath } from '@yume-chan/scrcpy';
import { fileStream } from './stream.mjs';

function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference) return difference;
  }
  return 0;
}

// Every protocol revision the client library knows, newest last: `AdbScrcpyOptions2_1` -> "2.1".
const OPTION_CLASSES = Object.entries(AdbScrcpy)
  .filter(([name]) => /^AdbScrcpyOptions\d/.test(name))
  .map(([name, Type]) => [name.replace('AdbScrcpyOptions', '').replaceAll('_', '.'), Type])
  .sort(([left], [right]) => compareVersions(left, right));

export function optionsForVersion(version) {
  let chosen = null;
  for (const [candidate, Type] of OPTION_CLASSES)
    if (compareVersions(version, candidate) >= 0) chosen = Type;
  return chosen || OPTION_CLASSES[0][1];
}

const CANDIDATE_SERVER_PATHS = [
  '/opt/homebrew/share/scrcpy/scrcpy-server',
  '/usr/local/share/scrcpy/scrcpy-server',
  '/usr/share/scrcpy/scrcpy-server',
  '/opt/homebrew/opt/scrcpy/share/scrcpy/scrcpy-server',
];

/** Finds the server jar that belongs to the installed scrcpy release. */
export function resolveServer({ scrcpyPath = 'scrcpy', serverPath = '' } = {}) {
  const candidates = [serverPath, process.env.SCRCPY_SERVER_PATH, ...CANDIDATE_SERVER_PATHS].filter(
    Boolean,
  );
  try {
    const binary = realpathSync(execFileSync('which', [scrcpyPath], { encoding: 'utf8' }).trim());
    candidates.unshift(join(dirname(dirname(binary)), 'share/scrcpy/scrcpy-server'));
  } catch {
    // scrcpy may not be on PATH; the shared paths above still apply.
  }
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found)
    throw new Error(
      'The scrcpy server jar was not found. Install scrcpy or set SCRCPY_SERVER_PATH.',
    );
  return found;
}

/** Reads the scrcpy version, preferably from the install path, otherwise from the binary. */
export function detectVersion({ scrcpyPath = 'scrcpy', serverPath = '', version = '' } = {}) {
  if (version) return version;
  if (process.env.SCRCPY_VERSION) return process.env.SCRCPY_VERSION;
  const jar = resolveServer({ scrcpyPath, serverPath });
  const fromPath = jar.match(/(\d+\.\d+(?:\.\d+)?)[\\/]share[\\/]scrcpy/);
  if (fromPath) return fromPath[1];
  try {
    const output = execFileSync(scrcpyPath, ['--version'], { encoding: 'utf8' });
    const match = output.match(/scrcpy\s+(\d+\.\d+(?:\.\d+)?)/i);
    if (match) return match[1];
  } catch {
    // Fall through to the newest protocol the client library supports.
  }
  return '3.1';
}

export class ScrcpySession {
  #client;
  #video;
  #queue = Promise.resolve();
  /**
   * @param {object} init
   * @param {import('@yume-chan/adb').Adb} init.adb
   * @param {object} init.launch resolved paths and version
   * @param {object} init.video {maxSize, maxFps, bitRate}
   */
  constructor({ client, video }) {
    this.#client = client;
    this.#video = video;
  }

  static async start(
    adb,
    {
      serverPath = '',
      scrcpyPath = 'scrcpy',
      version = '',
      video = {},
      clipboardAutosync = true,
    } = {},
  ) {
    const jar = resolveServer({ scrcpyPath, serverPath });
    const resolved = detectVersion({ scrcpyPath, serverPath, version });
    const Options = optionsForVersion(resolved);
    await AdbScrcpy.AdbScrcpyClient.pushServer(adb, fileStream(jar), DefaultServerPath);
    const options = new Options({
      audio: false,
      control: true,
      video: true,
      videoCodec: 'h264',
      maxSize: video.maxSize ?? 1024,
      maxFps: video.maxFps ?? 60,
      videoBitRate: video.bitRate ?? 6_000_000,
      sendFrameMeta: true,
      clipboardAutosync,
      powerOn: true,
      stayAwake: true,
      logLevel: 'info',
    });
    const client = await AdbScrcpy.AdbScrcpyClient.start(adb, DefaultServerPath, options);
    // The clipboard stream must be drained or the control channel can stall. Device clipboard
    // updates are intentionally dropped: this client only ever writes.
    client.clipboard?.pipeTo(new WritableStream({ write() {} })).catch(() => {});
    let stream;
    try {
      stream = await client.videoStream;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
    return new ScrcpySession({ client, video: stream });
  }

  get metadata() {
    return this.#video.metadata;
  }

  get width() {
    return this.#video.metadata?.width || this.#video.width || 0;
  }

  get height() {
    return this.#video.metadata?.height || this.#video.height || 0;
  }

  /** Raw H.264 access units, already stripped of scrcpy's packet framing. */
  get stream() {
    return this.#video.stream;
  }

  get sizeChanged() {
    return this.#video.sizeChanged;
  }

  /**
   * Control messages share one socket, so every writer is serialized: the browser, the agent and
   * the CLI must never interleave halves of a gesture.
   */
  get controller() {
    const controller = this.#client.controller;
    if (!controller) return undefined;
    const serialize =
      (method) =>
      (...args) => {
        const run = this.#queue.then(() => controller[method](...args));
        this.#queue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      };
    return {
      injectTouch: serialize('injectTouch'),
      injectKeyCode: serialize('injectKeyCode'),
      injectText: serialize('injectText'),
      injectScroll: serialize('injectScroll'),
      setClipboard: serialize('setClipboard'),
      startApp: serialize('startApp'),
      setScreenPowerMode: serialize('setScreenPowerMode'),
    };
  }

  get output() {
    return this.#client.output;
  }

  async close() {
    try {
      await this.#client.close();
    } catch {
      // The server may already have exited with the device.
    }
  }
}
