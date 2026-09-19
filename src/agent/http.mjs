import https from 'node:https';
import http from 'node:http';

const modelAgent = new https.Agent({ keepAlive: true, maxSockets: 2 });
const loopbackAgent = new http.Agent({ keepAlive: true, maxSockets: 2 });

// Keep the TypeSafe TLS connection warm across decisions and report where time went.
export function pooledRequest({ url, apiKey, method = 'GET', body, timeoutMs = 30_000 }) {
  const target = new URL(url);
  const loopback = target.protocol === 'http:' && target.hostname === '127.0.0.1';
  if ((target.protocol !== 'https:' && !loopback) || target.username || target.password)
    throw new Error('The model API requires HTTPS.');
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('A valid API key is required.');
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const started = performance.now();
  return new Promise((resolve, reject) => {
    let dns = 0;
    let connected = 0;
    let secure = 0;
    let ready = 0;
    const elapsed = () => performance.now() - started;
    const request = (loopback ? http : https).request(
      target,
      {
        agent: loopback ? loopbackAgent : modelAgent,
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': payload.length } : {}),
        },
      },
      (response) => {
        const firstByte = elapsed();
        const chunks = [];
        let length = 0;
        response.on('data', (chunk) => {
          length += chunk.length;
          if (length > 20 * 1024 * 1024) request.destroy(new Error('Response too large'));
          else chunks.push(chunk);
        });
        response.on('error', () => {
          clearTimeout(timer);
          reject(new Error('Model response interrupted; no action executed.'));
        });
        response.on('end', () => {
          clearTimeout(timer);
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`Model API returned HTTP ${response.statusCode}.`));
            return;
          }
          const wall = elapsed();
          const round = (value) => Math.round(value * 10) / 10;
          const bytes = Buffer.concat(chunks);
          Object.defineProperty(bytes, 'timing', {
            value: {
              wallMs: round(wall),
              dnsMs: round(dns),
              tcpMs: round(connected - dns),
              tlsMs: round(secure - connected),
              responseWaitMs: round(Math.max(0, firstByte - ready)),
              downloadMs: round(wall - firstByte),
              reusedConnection: request.reusedSocket,
              httpVersion: response.httpVersion,
              status: response.statusCode,
            },
          });
          resolve(bytes);
        });
      },
    );
    const timer = setTimeout(() => request.destroy(new Error('timeout')), timeoutMs);
    request.on('socket', (socket) => {
      if (!socket.connecting) {
        ready = elapsed();
        return;
      }
      socket.once('lookup', () => {
        dns = elapsed();
      });
      socket.once('connect', () => {
        connected = elapsed();
        if (loopback) {
          secure = connected;
          ready = connected;
        }
      });
      socket.once('secureConnect', () => {
        secure = elapsed();
        ready = secure;
      });
    });
    request.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Model API transport failed; no action executed.'));
    });
    request.end(payload);
  });
}

export function decodeJson(bytes) {
  if (!bytes.length) return null;
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('The model API returned invalid JSON.');
  }
}
