#!/usr/bin/env node
// Compiles the on-device helper into a dex jar and pushes it to the device.
//
// Needs a JDK (javac) and the Android SDK build-tools (d8). Both are optional: without
// the helper, scrcpy-jev falls back to the much slower `uiautomator dump` command.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, cpSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const helperDir = join(root, 'src/device/helper');
export const jarPath = join(helperDir, 'scrcpy-jev.jar');

export function sdkRoot() {
  return (
    process.env.ANDROID_SDK_ROOT ||
    process.env.ANDROID_HOME ||
    join(homedir(), 'Library/Android/sdk')
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw new Error(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}.`);
}

function newestDirectory(parent) {
  if (!existsSync(parent)) return null;
  const entries = readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return entries.length ? join(parent, entries.at(-1)) : null;
}

export function toolchain() {
  const sdk = sdkRoot();
  const buildTools = newestDirectory(join(sdk, 'build-tools'));
  const platforms = newestDirectory(join(sdk, 'platforms'));
  return {
    sdk,
    javaHome: process.env.JAVA_HOME || null,
    d8: buildTools ? join(buildTools, 'd8') : null,
    androidJar: platforms ? join(platforms, 'android.jar') : null,
  };
}

export function buildHelper({ quiet = false } = {}) {
  const { d8, androidJar } = toolchain();
  if (!d8 || !existsSync(d8)) throw new Error('d8 was not found in the Android SDK build-tools.');
  if (!androidJar || !existsSync(androidJar))
    throw new Error('android.jar was not found in the Android SDK platforms.');
  const javac = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin/javac') : 'javac';
  const classes = join(helperDir, 'classes');
  const dex = join(helperDir, 'dex');
  rmSync(classes, { recursive: true, force: true });
  rmSync(dex, { recursive: true, force: true });
  mkdirSync(classes, { recursive: true });
  mkdirSync(dex, { recursive: true });
  run(javac, [
    '-source',
    '8',
    '-target',
    '8',
    '-nowarn',
    '-classpath',
    androidJar,
    '-d',
    classes,
    join(helperDir, 'JevServer.java'),
  ]);
  run(d8, ['--min-api', '21', '--lib', androidJar, '--output', dex, ...collect(classes)]);
  const jar = join(helperDir, 'scrcpy-jev.jar');
  rmSync(jar, { force: true });
  cpSync(join(dex, 'classes.dex'), join(helperDir, 'classes.dex'));
  run('zip', ['-q', '-j', jar, join(helperDir, 'classes.dex')], { cwd: helperDir });
  rmSync(classes, { recursive: true, force: true });
  rmSync(dex, { recursive: true, force: true });
  rmSync(join(helperDir, 'classes.dex'), { force: true });
  if (!quiet) console.log(`Built ${jar}`);
  return jar;
}

function collect(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collect(path));
    else if (entry.name.endsWith('.class')) files.push(path);
  }
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  buildHelper();
}
