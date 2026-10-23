import { slotHomes, workerCount } from '../../../scripts/e2e-lock.mjs';
import { stopDaemon } from './daemon.js';

/**
 * However the run ends (passed, failed, or a test timed out), the demo daemons go with it: each worker
 * stops its own (e2e/fixtures.ts), and this catches those of a worker that crashed. Playwright stops vite
 * and the browser itself; when the run is killed outright, scripts/e2e-lock.mjs stops them.
 */
export default async function teardown(): Promise<void> {
  const run = { home: process.env.KLAUD_HOME!, claude: process.env.KLAUD_CLAUDE_HOME! };
  if (!run.home) return;
  const homes = Array.from({ length: workerCount() }, (_, w) => [slotHomes(run, w, 0).home, slotHomes(run, w, 1).home]).flat();
  await Promise.all(homes.map((home) => stopDaemon(home)));
}
