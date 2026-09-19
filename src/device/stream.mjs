import { createReadStream } from 'node:fs';

/** Adapts a Node read stream to the Web Streams shape the ADB sync writer expects. */
export function fileStream(path) {
  return ReadableStream.from(createReadStream(path));
}

/** Collects a Web/Node readable stream into one buffer. */
export async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
