import { spawn } from 'node:child_process';

/**
 * Whether an entry point should open a browser.
 *
 * `dev` opens one because it is interactive; `start` stays silent for headless use. `STUDIO_OPEN`
 * overrides both ways.
 */
export function shouldOpenBrowser({ mode = 'dev', env = process.env } = {}) {
  if (env.STUDIO_OPEN) return env.STUDIO_OPEN !== '0';
  return mode === 'dev';
}

/** The platform command that hands a URL to the default browser. */
export function browserCommand(platform, url) {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  return { command: 'xdg-open', args: [url] };
}

/**
 * Opens the studio in the default browser.
 *
 * Never throws: a machine without a browser (a container, a headless box) must still get a running
 * server, and the URL is printed either way. The child is detached so it outlives nothing we own.
 *
 * @returns {boolean} whether the launch command was started
 */
export function openBrowser(
  url,
  { platform = process.platform, spawnProcess = spawn, onError = () => {} } = {},
) {
  const { command, args } = browserCommand(platform, url);
  try {
    const child = spawnProcess(command, args, { stdio: 'ignore', detached: true });
    child.on?.('error', onError);
    child.unref?.();
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}
