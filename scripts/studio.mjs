#!/usr/bin/env node
// Starts the studio. `npm run dev` and `npm start` are the same server: there is no build step.
// `dev` also opens the studio in the default browser once the server is listening.
import { config as loadConfig, loadEnvironment } from '../src/config.mjs';
import { startStudio } from '../src/server/server.mjs';
import { openBrowser, shouldOpenBrowser } from '../src/server/open.mjs';

loadEnvironment();
const config = loadConfig();
const mode = process.argv[2] === 'start' ? 'start' : 'dev';

try {
  const studio = await startStudio({
    config,
    onLog: (message) => console.log(`· ${message}`),
  });
  console.log(`scrcpy-jev studio ready at ${studio.url}`);
  if (!config.typesafeApiKey)
    console.log('· TYPESAFE_API_KEY is not set: the studio will run, but tasks cannot start.');

  if (shouldOpenBrowser({ mode }))
    openBrowser(studio.url, {
      onError: () => console.log(`· Could not open a browser; visit ${studio.url}`),
    });

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) process.exit(0); // A second Ctrl+C must always win.
    stopping = true;
    console.log(`\n· shutting down (${signal})`);
    // A hard deadline guarantees the shell prompt comes back even if a device socket is wedged.
    const deadline = setTimeout(() => {
      console.error('· shutdown timed out; exiting');
      process.exit(0);
    }, 6000);
    deadline.unref();
    studio
      .close()
      .catch((error) => console.error(`· shutdown reported: ${error.message}`))
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
} catch (error) {
  console.error(`Could not start the studio: ${error.message}`);
  process.exitCode = 1;
}
