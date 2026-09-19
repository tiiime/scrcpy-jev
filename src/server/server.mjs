import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer } from 'ws';
import { config as defaultConfig, root } from '../config.mjs';
import { openRuntime } from '../device/runtime.mjs';
import { TypeSafePolicy } from '../agent/agent.mjs';
import { VideoHub } from './video.mjs';
import { InputChannel, parseInputCommand } from './input.mjs';
import { createStudioRunner } from './runner.mjs';
import { createStore, StudioError } from './store.mjs';

const WEB_ROOT = join(root, 'web');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function checkRequest(request) {
  const host = request.headers.host || '';
  const name = host.split(':')[0];
  if (!['localhost', '127.0.0.1', '[::1]'].includes(name))
    throw new StudioError('This studio is available on localhost only.', 403);
  const origin = request.headers.origin;
  if (origin && new URL(origin).host !== host) throw new StudioError('Origin not allowed.', 403);
  if (request.method === 'POST' && !origin)
    throw new StudioError('A same-origin request is required.', 403);
}

function sendJson(response, body, status = 200) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': payload.length,
  });
  response.end(payload);
  return undefined;
}

async function readJsonBody(request, limit = 16_384) {
  const text = await new Promise((resolve, reject) => {
    let data = '';
    request.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) reject(new StudioError('Task input is too long.'));
    });
    request.on('end', () => resolve(data));
    request.on('error', reject);
  });
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new StudioError('Invalid request.');
  }
}

/**
 * Starts the studio: one runtime (ADB + helper + scrcpy), one task store, one HTTP/WebSocket server.
 */
export async function startStudio({ config = defaultConfig(), onLog = () => {} } = {}) {
  const runtime = await openRuntime({ config, video: true, control: true, onLog });
  const { device, session, helper } = runtime;
  await device.assertReady();
  const status = await device.observe();

  const video = new VideoHub(session, {
    onError: (error) => onLog(`Video stream stopped: ${error.message}`),
  });
  video.setMetadata({
    width: session.metadata?.width || 0,
    height: session.metadata?.height || 0,
    deviceName: session.metadata?.deviceName || '',
  });
  session.sizeChanged?.(({ width, height }) => {
    video.setMetadata({ width, height, deviceName: session.metadata?.deviceName || '' });
  });

  const input = new InputChannel({
    session,
    surface: () => device.screen || status.screen,
    locked: () => Boolean(store.active()),
  });

  const policy = new TypeSafePolicy({
    apiKey: config.typesafeApiKey,
    model: config.typesafeModel,
    baseUrl: config.typesafeBaseUrl,
    threshold: config.confidence,
  });

  const runner = createStudioRunner({ device, policy });

  const store = createStore({ runner });

  const server = createServer(async (request, response) => {
    try {
      checkRequest(request);
      const route = new URL(request.url, `http://${request.headers.host}`).pathname;
      if (route === '/api/device' && request.method === 'GET') {
        return sendJson(response, {
          id: device.deviceId,
          name: device.model || device.deviceName,
          state: 'ready',
          transport: 'ADB · scrcpy',
          screen: device.screen || status.screen,
          video: { width: video.metadata?.width || 0, height: video.metadata?.height || 0 },
          model: config.typesafeModel,
          hasModelKey: Boolean(config.typesafeApiKey),
        });
      }
      if (route === '/api/snapshot' && request.method === 'GET') {
        const png = await device.screenshot();
        response.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-store',
          'Content-Length': png.length,
        });
        response.end(png);
        return undefined;
      }
      if (route === '/api/observation' && request.method === 'GET') {
        return sendJson(response, await device.observe());
      }
      if (route === '/api/runs' && request.method === 'GET')
        return sendJson(response, store.list());
      if (route === '/api/runs/clear' && request.method === 'POST')
        return sendJson(response, store.clear());
      if (route === '/api/runs' && request.method === 'POST') {
        if (!config.typesafeApiKey)
          throw new StudioError('TypeSafe credentials are missing on the server.', 503);
        return sendJson(response, store.start(await readJsonBody(request)), 201);
      }
      const stepMatch = route.match(/^\/api\/runs\/([^/]+)\/steps\/([^/]+)$/);
      if (stepMatch) {
        if (request.method !== 'GET') throw new StudioError('Not found.', 404);
        const [, id, step] = stepMatch;
        if (!store.get(id)) throw new StudioError('Run not found.', 404);
        const record = store.step(id, step);
        if (!record) throw new StudioError('No record for that step.', 404);
        return sendJson(response, record);
      }
      const runMatch = route.match(/^\/api\/runs\/([^/]+)(?:\/(stop|events))?$/);
      if (runMatch) {
        const [, id, action] = runMatch;
        if (action === 'stop' && request.method === 'POST')
          return sendJson(response, store.stop(id));
        if (action === 'events' && request.method === 'GET')
          return streamEvents(request, response, store, id);
        if (!action && request.method === 'GET') {
          const run = store.get(id);
          if (!run) throw new StudioError('Run not found.', 404);
          return sendJson(response, run);
        }
      }
      if (route.startsWith('/api/')) throw new StudioError('Not found.', 404);
      return await serveStatic(response, route);
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return undefined;
      }
      return sendJson(
        response,
        {
          error:
            error instanceof StudioError ? error.message : 'The studio hit an unexpected error.',
        },
        error instanceof StudioError ? error.status : 500,
      );
    }
  });

  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    try {
      checkRequest(request);
    } catch {
      socket.destroy();
      return;
    }
    if (new URL(request.url, `http://${request.headers.host}`).pathname !== '/api/stream') {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit('connection', client));
  });

  sockets.on('connection', (client) => {
    const remove = video.add(client);
    client.send(JSON.stringify({ type: 'ready', device: device.deviceName }));
    client.on('message', async (raw, binary) => {
      if (binary) return;
      let message;
      try {
        message = parseInputCommand(JSON.parse(raw.toString()));
      } catch (error) {
        client.send(JSON.stringify({ type: 'error', message: error.message }));
        return;
      }
      try {
        if (message.type === 'tap') await input.tap(message);
        else if (message.type === 'swipe') await input.swipe(message);
        else if (message.type === 'scroll') await input.scroll(message);
        else if (message.type === 'text') await input.text(message);
        else if (message.type === 'key') await input.key(message);
        else if (message.type === 'power') await input.power(message);
      } catch (error) {
        client.send(JSON.stringify({ type: 'error', message: error.message }));
      }
    });
    client.on('close', () => remove());
    client.on('error', () => remove());
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.studioPort, config.studioHost, resolve);
  });

  let closing = null;
  const shutdown = () => {
    closing ??= (async () => {
      video.close();
      await closeServer(server, sockets);
      await runtime.close();
    })();
    return closing;
  };

  return {
    server,
    store,
    runtime,
    video,
    url: `http://${config.studioHost}:${config.studioPort}`,
    close: shutdown,
  };
}

/**
 * Stops accepting connections and tears the existing ones down.
 *
 * `server.close()` alone only fires its callback once every client has gone away, and a browser
 * keeps an SSE stream and a WebSocket open indefinitely, so closing the studio used to hang while
 * the listening socket was already gone. Terminating the sockets first is what makes shutdown
 * deterministic.
 */
export async function closeServer(server, sockets, { graceMs = 1500 } = {}) {
  for (const client of sockets?.clients ?? []) {
    try {
      client.terminate();
    } catch {
      // The peer is already gone.
    }
  }
  try {
    sockets?.close();
  } catch {
    // The WebSocket server may not have been created.
  }
  server.closeAllConnections?.();
  await Promise.race([
    new Promise((resolve) => server.close(() => resolve())),
    new Promise((resolve) => {
      const timer = setTimeout(resolve, graceMs);
      timer.unref?.();
    }),
  ]);
}

function streamEvents(request, response, store, id) {
  const run = store.get(id);
  if (!run) throw new StudioError('Run not found.', 404);
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  const send = (state) => response.write(`data: ${JSON.stringify(state)}\n\n`);
  send(run);
  const unsubscribe = store.subscribe(id, send);
  const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  request.on('close', cleanup);
  return undefined;
}

async function serveStatic(response, route) {
  const relative = route === '/' ? 'index.html' : normalize(route).replace(/^(\.\.[/\\])+/, '');
  const path = join(WEB_ROOT, relative);
  if (!path.startsWith(WEB_ROOT)) throw new StudioError('Not found.', 404);
  let body;
  try {
    body = await readFile(path);
  } catch {
    throw new StudioError('Not found.', 404);
  }
  response.writeHead(200, {
    'Content-Type': TYPES[extname(path)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}
