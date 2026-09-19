// Minimal Chrome DevTools Protocol driver: open the studio in headless Chrome, capture console
// output and exceptions, inspect the page state, and save a screenshot.
import { writeFile } from 'node:fs/promises';
import { WebSocket } from 'ws';

const url = process.argv[2] || 'http://127.0.0.1:3050';
const out = process.argv[3] || '/tmp/studio-shot.png';
const waitMs = Number(process.argv[4] || 9000);

const version = await (await fetch('http://127.0.0.1:9222/json/version')).json();
const browser = new WebSocket(version.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((resolve) => browser.once('open', resolve));

let nextId = 0;
const pending = new Map();
const events = [];
browser.on('message', (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.consoleAPICalled')
    events.push(
      `console.${message.params.type}: ${message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`,
    );
  if (message.method === 'Runtime.exceptionThrown')
    events.push(
      `EXCEPTION: ${message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text}`,
    );
  if (message.method === 'Log.entryAdded')
    events.push(`log.${message.params.entry.level}: ${message.params.entry.text}`);
});

const send = (method, params = {}, sessionId) => {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    browser.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
};

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
await send('Log.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
await send(
  'Emulation.setDeviceMetricsOverride',
  { width: 1500, height: 940, deviceScaleFactor: 2, mobile: false },
  sessionId,
);
await send('Page.navigate', { url }, sessionId);
await new Promise((resolve) => setTimeout(resolve, waitMs));

const evaluate = async (expression) => {
  const result = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (result.exceptionDetails) return { error: result.exceptionDetails.exception?.description };
  return result.result.value;
};

const state = await evaluate(`(() => {
  const badge = document.getElementById('connection-badge');
  const error = document.getElementById('stream-error');
  const note = document.getElementById('stream-note');
  const canvas = document.getElementById('screen');
  let painted = false;
  try {
    const context = canvas.getContext('2d');
    const data = context.getImageData(0, 0, Math.min(80, canvas.width), Math.min(80, canvas.height)).data;
    painted = data.some((value, index) => index % 4 !== 3 && value > 8);
  } catch (failure) { painted = 'error: ' + failure.message; }
  return {
    badge: badge.textContent.trim(),
    badgeClass: badge.className,
    streamErrorHidden: error.hidden,
    streamErrorText: document.getElementById('stream-error-text').textContent,
    noteHidden: note.hidden,
    noteText: note.textContent,
    caption: document.getElementById('stage-caption').textContent,
    canvas: canvas.width + 'x' + canvas.height,
    canvasPainted: painted,
    device: document.getElementById('device-name').textContent,
    hasVideoDecoder: typeof VideoDecoder !== 'undefined',
  };
})()`);

const shot = await send(
  'Page.captureScreenshot',
  { format: 'png', captureBeyondViewport: false },
  sessionId,
);
await writeFile(out, Buffer.from(shot.data, 'base64'));

console.log('STATE', JSON.stringify(state, null, 2));
console.log('EVENTS', events.length ? events.slice(0, 25).join('\n') : '(none)');
console.log('screenshot ->', out);

await send('Target.closeTarget', { targetId });
browser.close();
process.exit(0);
