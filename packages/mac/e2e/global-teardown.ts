import { stopDaemon } from './daemon.js';

/**
 * However the run ends (passed, failed, or a test timed out), the demo daemon goes with it. Playwright
 * stops vite and the browser itself; when the run is killed outright, scripts/e2e-lock.mjs stops them.
 */
export default async function teardown(): Promise<void> {
  if (process.env.KLAUD_HOME) await stopDaemon(process.env.KLAUD_HOME);
}
