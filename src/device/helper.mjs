// Client for the on-device observation helper (see src/device/helper/JevServer.java).
//
// `uiautomator dump` costs about 2.7 s per call: every invocation boots a JVM and reconnects the
// accessibility bridge. The helper connects once and answers framed JSON requests over an ADB
// abstract socket, which brings an observation down to roughly 10 ms.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { shell } from './adb.mjs';
import { fileStream } from './stream.mjs';

export const HELPER_SOCKET = 'scrcpy_jev';
export const HELPER_MAIN = 'com.scrcpyjev.JevServer';
const REMOTE_JAR = '/data/local/tmp/scrcpy-jev.jar';

class FrameReader {
  #reader;
  #buffer = Buffer.alloc(0);
  constructor(reader) {
    this.#reader = reader;
  }
  async readFrame() {
    while (this.#buffer.length < 4) {
      const { done, value } = await this.#reader.read();
      if (done) throw new Error('The on-device helper closed the connection.');
      this.#buffer = Buffer.concat([this.#buffer, Buffer.from(value)]);
    }
    const length = this.#buffer.readUInt32BE(0);
    if (length > 1 << 24) throw new Error('The on-device helper sent an oversized frame.');
    while (this.#buffer.length < 4 + length) {
      const { done, value } = await this.#reader.read();
      if (done) throw new Error('The on-device helper closed the connection.');
      this.#buffer = Buffer.concat([this.#buffer, Buffer.from(value)]);
    }
    const payload = this.#buffer.subarray(4, 4 + length).toString('utf8');
    this.#buffer = this.#buffer.subarray(4 + length);
    return JSON.parse(payload);
  }
}

export class JevHelper {
  #socket;
  #writer;
  #read;
  #queue = Promise.resolve();
  #closed = false;
  #process = null;
  #logs = [];

  constructor(socket, { process = null } = {}) {
    this.#socket = socket;
    this.#writer = socket.writable.getWriter();
    const reader = new FrameReader(socket.readable.getReader());
    this.#read = () => reader.readFrame();
    this.#process = process;
  }

  static async build(jarPath) {
    return createHash('sha256')
      .update(await readFile(jarPath))
      .digest('hex')
      .slice(0, 12);
  }

  static async #open(adb) {
    return new JevHelper(await adb.createSocket(`localabstract:${HELPER_SOCKET}`));
  }

  static async #tryOpen(adb) {
    try {
      return await JevHelper.#open(adb);
    } catch {
      return null;
    }
  }

  /**
   * Keeps a helper matching `jarPath` running and returns a connected client.
   *
   * A helper started by an earlier run is reused when its build hash matches, so the studio and the
   * CLI can share one process. Otherwise the old process is replaced.
   */
  static async ensure(adb, jarPath, { attempts = 60, intervalMs = 100 } = {}) {
    const build = await JevHelper.build(jarPath);
    const existing = await JevHelper.#tryOpen(adb);
    if (existing) {
      try {
        const pong = await existing.request({ cmd: 'ping' });
        if (pong?.build === build) return existing;
      } catch {
        // Fall through and replace it.
      }
      await existing.close();
    }
    await shell(adb, ['pkill', '-f', HELPER_MAIN]).catch(() => '');
    const sync = await adb.sync();
    try {
      await sync.write({ filename: REMOTE_JAR, file: fileStream(jarPath) });
    } finally {
      await sync.dispose();
    }
    // The process is attached to this socket, so it lives exactly as long as the caller holds it.
    const process = await adb.subprocess.noneProtocol.spawn([
      'env',
      `CLASSPATH=${REMOTE_JAR}`,
      'app_process',
      '/',
      HELPER_MAIN,
      build,
    ]);
    const logs = [];
    process.output
      .pipeTo(
        new WritableStream({
          write(chunk) {
            logs.push(Buffer.from(chunk).toString('utf8'));
            while (logs.join('').length > 4000) logs.shift();
          },
        }),
      )
      .catch(() => {});
    for (let attempt = 0; attempt < attempts; attempt++) {
      await delay(intervalMs);
      const helper = await JevHelper.#tryOpen(adb);
      if (!helper) continue;
      helper.#process = process;
      helper.#logs = logs;
      try {
        const pong = await helper.request({ cmd: 'ping' });
        if (pong?.build === build) return helper;
      } catch {
        // The socket appeared before the server finished starting.
      }
      await helper.close();
      break;
    }
    await process.kill().catch(() => {});
    throw new Error(
      `The on-device helper did not start. Device output:\n${logs.join('').trim() || '(none)'}`,
    );
  }

  get socketPath() {
    return HELPER_SOCKET;
  }

  get logs() {
    return this.#logs.join('');
  }

  /** Serializes requests: the helper answers one frame at a time. */
  request(payload) {
    const run = this.#queue.then(() => this.#exchange(payload));
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #exchange(payload) {
    if (this.#closed) throw new Error('The on-device helper connection is closed.');
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    await this.#writer.write(new Uint8Array(Buffer.concat([header, body])));
    return this.#read();
  }

  async dump() {
    const response = await this.request({ cmd: 'dump' });
    if (!response?.ok) throw new Error(response?.error || 'The on-device helper failed to dump.');
    return response;
  }

  /**
   * Drops this client's socket only.
   *
   * The helper process is shared: whoever started it first holds the handle, but another studio or
   * the CLI may be connected to the same socket. Killing it here used to break those clients, so
   * the process now retires itself after `IDLE_TIMEOUT_MS` instead.
   */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#writer.releaseLock();
    } catch {
      // The socket may already be gone.
    }
    try {
      await this.#socket.close();
    } catch {
      // Ignore a socket the device already closed.
    }
    this.#process = null;
  }
}

export async function helperExists(jarPath) {
  try {
    return (await stat(jarPath)).isFile();
  } catch {
    return false;
  }
}
