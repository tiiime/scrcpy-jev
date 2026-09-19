// Fans the scrcpy H.264 stream out to browser clients.
//
// The stream is never re-encoded: each scrcpy access unit is forwarded as one binary frame with a
// one-byte header, and the browser decodes it with WebCodecs.
//
// scrcpy sends its SPS/PPS once, at the very start of the session, and only the encoder decides
// when the next IDR arrives. A browser that opens the studio later would therefore never be able to
// configure a decoder, so the hub keeps the current group of pictures and replays it on connect.
import { WebSocket } from 'ws';

const FLAG_CONFIGURATION = 1;
const FLAG_KEYFRAME = 2;
const MAX_CACHED_FRAMES = 900;
const MAX_CACHED_BYTES = 12 * 1024 * 1024;

/** Reads profile_idc / constraint flags / level_idc out of an H.264 SPS NAL unit. */
export function avcCodecString(description) {
  const bytes = Buffer.from(description);
  for (let index = 0; index + 4 < bytes.length; index++) {
    const isStartCode =
      bytes[index] === 0 &&
      bytes[index + 1] === 0 &&
      (bytes[index + 2] === 1 || (bytes[index + 2] === 0 && bytes[index + 3] === 1));
    if (!isStartCode) continue;
    const header = bytes[index + 2] === 1 ? index + 3 : index + 4;
    if ((bytes[header] & 0x1f) !== 7) continue; // 7 = sequence parameter set
    const profile = bytes[header + 1];
    const constraints = bytes[header + 2];
    const level = bytes[header + 3];
    if (profile === undefined || constraints === undefined || level === undefined) break;
    const hex = (value) => value.toString(16).padStart(2, '0');
    return `avc1.${hex(profile)}${hex(constraints)}${hex(level)}`;
  }
  return null;
}

export class VideoHub {
  #clients = new Set();
  #metadata = null;
  #codec = null;
  #closed = false;
  #configuration = null;
  #group = [];
  #groupBytes = 0;
  #framesSeen = 0;

  constructor(session, { onError = () => {} } = {}) {
    this.session = session;
    this.#pump(onError);
  }

  get metadata() {
    return this.#metadata;
  }

  get stats() {
    return { frames: this.#framesSeen, cached: this.#group.length, clients: this.#clients.size };
  }

  async #pump(onError) {
    try {
      const reader = this.session.stream.getReader();
      while (!this.#closed) {
        const { done, value } = await reader.read();
        if (done) break;
        const packet = value;
        if (packet.type === 'configuration') {
          const codec = avcCodecString(packet.data);
          const changed = codec && codec !== this.#codec;
          if (codec) this.#codec = codec;
          this.#remember(FLAG_CONFIGURATION | FLAG_KEYFRAME, packet.data);
          if (changed) this.broadcastMetadata();
          this.#broadcast(FLAG_CONFIGURATION | FLAG_KEYFRAME, packet.data);
          continue;
        }
        if (!packet.data?.length) continue;
        const flags = packet.keyframe ? FLAG_KEYFRAME : 0;
        this.#remember(flags, packet.data);
        this.#broadcast(flags, packet.data);
      }
    } catch (error) {
      if (!this.#closed) onError(error);
    }
  }

  /**
   * Keeps the configuration record plus every access unit since the last key frame, capped so a
   * slow encoder cannot grow the cache without bound.
   */
  #remember(flags, data) {
    this.#framesSeen++;
    const frame = Buffer.allocUnsafe(data.length + 1);
    frame[0] = flags;
    frame.set(data, 1);
    if (flags & FLAG_CONFIGURATION) this.#configuration = frame;
    if (flags & FLAG_KEYFRAME) {
      this.#group = [frame];
      this.#groupBytes = frame.length;
      return;
    }
    if (!this.#group.length) return; // Nothing to attach to until the first key frame.
    this.#group.push(frame);
    this.#groupBytes += frame.length;
    while (
      this.#group.length > MAX_CACHED_FRAMES ||
      (this.#groupBytes > MAX_CACHED_BYTES && this.#group.length > 1)
    ) {
      // Drop from the front: the tail still references the newest key frame the longest.
      this.#groupBytes -= this.#group[1].length;
      this.#group.splice(1, 1);
    }
  }

  #broadcast(flags, data) {
    const frame = Buffer.allocUnsafe(data.length + 1);
    frame[0] = flags;
    frame.set(data, 1);
    for (const client of this.#clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      client.send(frame, { binary: true });
    }
  }

  setMetadata(metadata) {
    this.#metadata = { ...this.#metadata, ...metadata };
    this.broadcastMetadata();
  }

  broadcastMetadata() {
    if (!this.#metadata) return;
    const message = JSON.stringify({ type: 'video', ...this.#metadata, codec: this.#codec });
    for (const client of this.#clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  }

  add(socket) {
    this.#clients.add(socket);
    if (this.#metadata)
      socket.send(JSON.stringify({ type: 'video', ...this.#metadata, codec: this.#codec }));
    // Replay the current group of pictures so a late client can decode immediately.
    if (this.#configuration) socket.send(this.#configuration, { binary: true });
    for (const frame of this.#group) socket.send(frame, { binary: true });
    return () => this.#clients.delete(socket);
  }

  close() {
    this.#closed = true;
    this.#clients.clear();
  }
}
