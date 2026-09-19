// Opens the studio in headless Chrome with a probe injected before the page scripts run, so the
// decoder pipeline can be observed without adding diagnostics to the app itself.
import { writeFile } from 'node:fs/promises';
import { WebSocket } from 'ws';

const url = process.argv[2] || 'http://127.0.0.1:3050';
const waitMs = Number(process.argv[3] || 9000);
const out = process.argv[4] || '/tmp/studio-probe.png';

const version = await (await fetch('http://127.0.0.1:9222/json/version')).json();
const browser = new WebSocket(version.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((resolve) => browser.once('open', resolve));
let nextId = 0;
const pending = new Map();
browser.on('message', (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
  }
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
await send('Page.enable', {}, sessionId);

const probe = `
window.__trace = [];
const push = (event, detail) => window.__trace.push({
  t: Math.round(performance.now()),
  event,
  detail: detail === undefined ? '' : String(detail).slice(0, 160),
});
const NativeSocket = window.WebSocket;
window.WebSocket = class extends NativeSocket {
  constructor(url) {
    super(url);
    push('ws.open', url);
    this.addEventListener('message', (message) => {
      if (typeof message.data === 'string') {
        const payload = JSON.parse(message.data);
        push('ws.text', payload.type + (payload.codec ? ' codec=' + payload.codec : ''));
      } else {
        const bytes = new Uint8Array(message.data);
        push('ws.binary', 'flags=' + bytes[0] + ' len=' + (bytes.length - 1));
      }
    });
    this.addEventListener('close', () => push('ws.close'));
    this.addEventListener('error', () => push('ws.error'));
  }
  send(payload) { push('ws.send', payload); return super.send(payload); }
};
if (window.VideoDecoder) {
  const NativeDecoder = window.VideoDecoder;
  const state = { created: 0, configured: 0, decoded: 0, key: 0, delta: 0, output: 0, errors: 0, throws: 0 };
  window.__decoder = state;
  window.VideoDecoder = class extends NativeDecoder {
    constructor(init) {
      super({
        output: (frame) => { state.output++; state.lastOutputAt = Math.round(performance.now()); if (state.output === 1) push('decoder.firstOutput'); return init.output(frame); },
        error: (error) => { state.errors++; push('decoder.error', error && error.message); return init.error(error); },
      });
      state.created++;
      push('decoder.created', 'total=' + state.created);
    }
    configure(config) {
      state.configured++;
      push('decoder.configure', config.codec + ' ' + config.codedWidth + 'x' + config.codedHeight + ' fmt=' + (config.avc && config.avc.format));
      return super.configure(config);
    }
    decode(chunk) {
      state.decoded++;
      if (chunk.type === 'key') state.key++; else state.delta++;
      try { return super.decode(chunk); }
      catch (error) { state.throws++; push('decoder.decodeThrow', error.message); throw error; }
    }
  };
}
window.addEventListener('error', (event) => push('window.error', event.message));
window.addEventListener('unhandledrejection', (event) => push('window.rejection', event.reason && event.reason.message));
`;

await send('Page.addScriptToEvaluateOnNewDocument', { source: probe }, sessionId);
await send(
  'Emulation.setDeviceMetricsOverride',
  { width: 1500, height: 940, deviceScaleFactor: 1, mobile: false },
  sessionId,
);
await send('Page.navigate', { url }, sessionId);
await new Promise((resolve) => setTimeout(resolve, waitMs));

const read = async (expression) => {
  const result = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  return result.exceptionDetails
    ? { error: result.exceptionDetails.exception?.description }
    : result.result.value;
};

const summary = await read(`JSON.stringify({
  badge: document.getElementById('connection-badge').textContent.trim(),
  note: document.getElementById('stream-note').hidden ? null : document.getElementById('stream-note').textContent,
  errorText: document.getElementById('stream-error').hidden ? null : document.getElementById('stream-error-text').textContent,
  sinceLastOutputMs: window.__decoder && window.__decoder.lastOutputAt ? Math.round(performance.now() - window.__decoder.lastOutputAt) : null,
  decoder: window.__decoder || null,
  traceLength: window.__trace.length,
})`);
console.log('SUMMARY', summary);
const trace = await read(`JSON.stringify(window.__trace.slice(-160))`);
const events = JSON.parse(trace);
const collapsed = [];
for (const entry of events) {
  const previous = collapsed.at(-1);
  const sameBinary =
    entry.event === 'ws.binary' &&
    previous?.event === 'ws.binary' &&
    previous.detail === entry.detail;
  if (
    previous &&
    previous.event === entry.event &&
    (entry.event !== 'ws.binary' || sameBinary) &&
    previous.count < 5000
  ) {
    previous.count++;
    continue;
  }
  collapsed.push({ ...entry, count: 1 });
}
for (const entry of collapsed.slice(0, 60))
  console.log(
    `${String(entry.t).padStart(6)}ms  ${entry.event}${entry.count > 1 ? ` x${entry.count}` : ''}  ${entry.detail}`,
  );

const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
await writeFile(out, Buffer.from(shot.data, 'base64'));
await send('Target.closeTarget', { targetId });
browser.close();
process.exit(0);
