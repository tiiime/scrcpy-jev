import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));

// Exported variables win; .env.local overrides .env. No value is ever printed.
export function loadEnvironment() {
  for (const name of ['.env.local', '.env']) {
    const path = new URL(`../${name}`, import.meta.url);
    if (existsSync(path)) process.loadEnvFile(path);
  }
}

function integer(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}

export function config() {
  return {
    adbHost: process.env.ADB_HOST || '127.0.0.1',
    adbPort: integer('ADB_PORT', 5037, { min: 1, max: 65_535 }),
    serial: process.env.ANDROID_SERIAL || process.env.ADB_SERIAL || '',
    scrcpyPath: process.env.SCRCPY_PATH || 'scrcpy',
    scrcpyVersion: process.env.SCRCPY_VERSION || '',
    scrcpyServerPath: process.env.SCRCPY_SERVER_PATH || '',
    video: {
      maxSize: integer('SCRCPY_MAX_SIZE', 1024, { min: 0, max: 4096 }),
      maxFps: integer('SCRCPY_MAX_FPS', 60, { min: 0, max: 120 }),
      bitRate: integer('SCRCPY_BIT_RATE', 6_000_000, { min: 100_000, max: 100_000_000 }),
    },
    typesafeApiKey: process.env.TYPESAFE_API_KEY || '',
    typesafeModel: process.env.TYPESAFE_MODEL || 'jev-latest',
    typesafeBaseUrl: process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai/v1/systemone',
    confidence: Number(process.env.JEV_CONFIDENCE || 0),
    studioHost: process.env.STUDIO_HOST || '127.0.0.1',
    studioPort: integer('STUDIO_PORT', 3050, { min: 1, max: 65_535 }),
    traceDir: process.env.JEV_TRACE_DIR || 'artifacts',
  };
}
