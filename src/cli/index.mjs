#!/usr/bin/env node
// scrcpy-jev command line: direct controls, observation, and the agent loop.
import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config as loadConfig, loadEnvironment } from '../config.mjs';
import { adbServer, listDevices } from '../device/adb.mjs';
import { helperExists } from '../device/helper.mjs';
import { HELPER_JAR, openRuntime } from '../device/runtime.mjs';
import { TypeSafePolicy, runAgent } from '../agent/agent.mjs';
import { detectVersion, resolveServer } from '../device/scrcpy-session.mjs';

const help = `scrcpy-jev — a local Android agent driven by scrcpy and ADB

npm run agent COMMAND [ARGS] [OPTIONS]

Commands:
  devices                        List connected device serials, models and states
  doctor                         Check ADB, scrcpy, the observation helper and credentials
  observe                        Print the UI state the policy sees (--out PATH to save)
  screenshot                     Save a PNG (--out PATH)
  tap X Y                        Tap screen pixels
  swipe X1 Y1 X2 Y2 [MS]         Swipe in screen pixels
  type TEXT                      Type into the focused field (--clear to replace it first)
  clear                          Clear the focused field
  key enter|tab|delete|forward_delete
  home | back | recent           System navigation
  open PACKAGE                   Launch an installed app
  run GOAL                       Preview one decision; --execute runs the loop

Options:
  --device SERIAL                Or ANDROID_SERIAL
  --out PATH                     Save observe JSON or a screenshot PNG
  --text VALUE                   Repeatable exact text candidates for the policy
  --steps N                      Maximum actions (default 10, maximum 100)
  --confidence N                 Optional operation/target cutoff (default 0; disabled)
  --wait-timeout-ms N            Consecutive loading wait budget (default 15000)
  --execute                      Execute policy-selected actions
  --trace PATH                   Append decisions, actions and the final state (JSONL)

Environment: TYPESAFE_API_KEY and TYPESAFE_MODEL for run; ANDROID_SERIAL to pick a device.
`;

async function save(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data, { flag: 'wx', mode: 0o600 });
}

async function main() {
  loadEnvironment();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      device: { type: 'string' },
      out: { type: 'string' },
      clear: { type: 'boolean' },
      execute: { type: 'boolean' },
      trace: { type: 'string' },
      steps: { type: 'string', default: '10' },
      confidence: { type: 'string', default: '0' },
      'wait-timeout-ms': { type: 'string', default: '15000' },
      text: { type: 'string', multiple: true, default: [] },
    },
  });
  const [command, ...args] = positionals;
  if (!command || values.help) {
    console.log(help);
    return;
  }
  const config = loadConfig();
  if (values.device) config.serial = values.device;
  const print = (value) => console.log(JSON.stringify(value, null, 2));
  const arity = (min, max = min) => {
    if (args.length < min || args.length > max)
      throw new Error(`Invalid arguments for ${command}. Use --help.`);
  };

  if (command === 'devices') {
    arity(0);
    print(await listDevices(adbServer({ host: config.adbHost, port: config.adbPort })));
    return;
  }

  if (command === 'doctor') {
    arity(0);
    const report = {
      adb: { host: config.adbHost, port: config.adbPort, ok: false, devices: [] },
      scrcpy: { version: null, serverJar: null, ok: false },
      helper: { jar: HELPER_JAR, built: await helperExists(HELPER_JAR), ok: false },
      model: { apiKey: Boolean(config.typesafeApiKey), model: config.typesafeModel },
    };
    try {
      report.adb.devices = await listDevices(
        adbServer({ host: config.adbHost, port: config.adbPort }),
      );
      report.adb.ok = report.adb.devices.some((device) => device.connected);
    } catch (error) {
      report.adb.error = error.message;
    }
    try {
      report.scrcpy.serverJar = resolveServer({
        scrcpyPath: config.scrcpyPath,
        serverPath: config.scrcpyServerPath,
      });
      report.scrcpy.version = detectVersion({
        scrcpyPath: config.scrcpyPath,
        serverPath: config.scrcpyServerPath,
        version: config.scrcpyVersion,
      });
      report.scrcpy.ok = true;
    } catch (error) {
      report.scrcpy.error = error.message;
    }
    if (report.adb.ok) {
      const runtime = await openRuntime({ config, video: false, control: false, onLog: () => {} });
      try {
        const observation = await runtime.device.observe();
        report.helper.ok = true;
        report.helper.elements = observation.elements.length;
        report.helper.screen = observation.screen;
      } finally {
        await runtime.close();
      }
    }
    print(report);
    if (!report.adb.ok || !report.scrcpy.ok || !report.helper.ok) process.exitCode = 1;
    return;
  }

  const runtime = await openRuntime({
    config,
    video: false,
    control: true,
    onLog: (m) => console.error(m),
  });
  try {
    const { device } = runtime;
    await device.assertReady();
    if (command === 'observe') {
      arity(0);
      const observation = await device.observe();
      if (values.out) {
        await save(values.out, JSON.stringify(observation, null, 2) + '\n');
        print({ saved: values.out, elements: observation.elements.length });
      } else print(observation);
      return;
    }
    if (command === 'screenshot') {
      arity(0);
      const path = values.out || `artifacts/screen-${Date.now()}.png`;
      await save(path, await device.screenshot());
      print({ saved: path });
      return;
    }
    if (command === 'run') {
      arity(1);
      const goal = args.join(' ');
      const policy = new TypeSafePolicy({
        apiKey: config.typesafeApiKey,
        model: config.typesafeModel,
        baseUrl: config.typesafeBaseUrl,
        threshold: Number(values.confidence),
      });
      const trace = values.trace ? [] : null;
      const result = await runAgent({
        device,
        policy,
        goal,
        texts: values.text,
        execute: Boolean(values.execute),
        maxSteps: Number(values.steps),
        waitTimeoutMs: Number(values['wait-timeout-ms']),
        onStep: (decision) => {
          trace?.push({ type: 'decision', at: Date.now(), ...decision });
          console.error(
            `step ${decision.step}: ${decision.status}${decision.operation ? ` ${decision.operation}` : ''}${decision.label ? ` — ${decision.label}` : ''}${
              decision.latencyMs ? ` (${Math.round(decision.latencyMs)} ms)` : ''
            }`,
          );
        },
        onAction: (action) => {
          trace?.push({ type: 'action', at: Date.now(), ...action });
          console.error(`  executed ${action.operation}: ${action.label}`);
        },
      });
      trace?.push({
        type: 'result',
        at: Date.now(),
        status: result.status,
        timings: result.timings,
      });
      if (values.trace) {
        await mkdir(dirname(values.trace), { recursive: true });
        await writeFile(
          values.trace,
          trace.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
          {
            flag: 'wx',
            mode: 0o600,
          },
        );
      }
      print({
        status: result.status,
        steps: result.steps,
        timings: result.timings,
        decision: result.decision && {
          operation: result.decision.operation,
          label: result.decision.label,
          confidence: result.decision.confidence,
          reason: result.decision.reason,
        },
        ...(values.trace ? { trace: values.trace } : {}),
      });
      return;
    }
    if (command === 'tap') {
      arity(2);
      await device.act({ type: 'tap', x: Number(args[0]), y: Number(args[1]) });
      print({ tapped: [Number(args[0]), Number(args[1])] });
      return;
    }
    if (command === 'swipe') {
      arity(4, 5);
      await device.act({
        type: 'swipe',
        startX: Number(args[0]),
        startY: Number(args[1]),
        endX: Number(args[2]),
        endY: Number(args[3]),
        duration: args[4] ? Number(args[4]) : 300,
      });
      print({ swiped: args.slice(0, 4).map(Number) });
      return;
    }
    if (command === 'type' || command === 'clear') {
      arity(command === 'type' ? 1 : 0, command === 'type' ? 1000 : 0);
      const text = args.join(' ');
      const expected = await device.observe();
      await device.act(
        command === 'clear' ? { type: 'clear' } : { type: 'type', text, clear: values.clear },
        { expected },
      );
      print({ [command]: command === 'type' ? text : true });
      return;
    }
    if (command === 'key') {
      arity(1);
      await device.act({ type: 'key', key: args[0] });
      print({ key: args[0] });
      return;
    }
    if (['home', 'back', 'recent'].includes(command)) {
      arity(0);
      await device.act({ type: 'global', name: command });
      print({ global: command });
      return;
    }
    if (command === 'open') {
      arity(1);
      await device.listApps();
      await device.act({ type: 'open-app', packageName: args[0] });
      print({ opened: args[0] });
      return;
    }
    throw new Error(`Unknown command: ${command}. Use --help.`);
  } finally {
    await runtime.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
