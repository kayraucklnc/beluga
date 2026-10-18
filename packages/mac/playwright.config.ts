import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

// One klaud home for the run: the demo daemon (global setup) and the dev server's bridge share it.
process.env.KLAUD_HOME ??= mkdtempSync(path.join(os.tmpdir(), 'klaud-e2e-'));
// A pretend ~/.claude the demo daemon watches for Claude Code sessions (e2e/claude-code.spec.ts writes there).
process.env.KLAUD_CLAUDE_HOME ??= mkdtempSync(path.join(os.tmpdir(), 'klaud-e2e-claude-'));
// E2E_PORT lets several runs go at once (each with its own dev server and daemon).
const port = Number(process.env.E2E_PORT ?? 1421);
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
  use: { baseURL: `http://localhost:${port}`, viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure' },
  webServer: { command: `npx vite --port ${port} --strictPort`, url: `http://localhost:${port}`, reuseExistingServer: false, env: { KLAUD_HOME: process.env.KLAUD_HOME } },
});
