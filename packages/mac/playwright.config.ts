import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

// One klaud home for the run: the demo daemon (global setup) and the dev server's bridge share it.
process.env.KLAUD_HOME ??= mkdtempSync(path.join(os.tmpdir(), 'klaud-e2e-'));

export default defineConfig({
  testDir: 'e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  globalSetup: './e2e/daemon.ts',
  use: { baseURL: 'http://localhost:1421', viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure' },
  webServer: { command: 'npx vite --port 1421 --strictPort', url: 'http://localhost:1421', reuseExistingServer: false, env: { KLAUD_HOME: process.env.KLAUD_HOME } },
});
