import { defineConfig } from '@playwright/test';
import { homesFor, portFor, worktreeOf } from '../../scripts/e2e-lock.mjs';

// `npm run e2e` runs through scripts/e2e-lock.mjs: one Mac e2e run at a time, nothing left behind.
// It hands every run its worktree's own port and demo home; a bare `playwright test` gets the same ones.
// Never an inherited KLAUD_HOME without the lock (inside Klaud that's your real data; the demo home is wiped).
const worktree = worktreeOf(import.meta.dirname);
if (!process.env.BELUGA_E2E_RUN && !process.env.KLAUD_E2E_RUN) {
  // Both names: the daemon reads BELUGA_HOME first, so an inherited one must never be left pointing at real data.
  process.env.BELUGA_HOME = process.env.KLAUD_HOME = homesFor(worktree).home;
  // A pretend ~/.claude the demo daemon watches for Claude Code sessions (e2e/claude-code.spec.ts writes there).
  process.env.BELUGA_CLAUDE_HOME = process.env.KLAUD_CLAUDE_HOME = homesFor(worktree).claude;
}
const port = Number(process.env.E2E_PORT || portFor(worktree));
process.env.E2E_PORT = String(port);

export default defineConfig({
  testDir: 'e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  globalSetup: './e2e/daemon.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    // Every spec starts past the first-run welcome (src/onboarding); e2e/onboarding.spec.ts clears this.
    storageState: { cookies: [], origins: [{ origin: `http://localhost:${port}`, localStorage: [{ name: 'klaud.onboarding.v1', value: JSON.stringify({ version: 'e2e', at: 0, how: 'finished' }) }] }] },
  },
  webServer: { command: `npx vite --port ${port} --strictPort`, url: `http://localhost:${port}`, reuseExistingServer: false, env: { BELUGA_HOME: process.env.KLAUD_HOME!, KLAUD_HOME: process.env.KLAUD_HOME! } },
});
