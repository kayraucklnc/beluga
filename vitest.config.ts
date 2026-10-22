import { defineConfig } from 'vitest/config';
import { workerCount } from './scripts/test-lock.mjs';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Ten worktrees testing at once leave the Mac usable: half the cores per run (KLAUD_TEST_WORKERS
    // overrides it), and a few runs at a time machine-wide (scripts/test-lock.mjs, KLAUD_TEST_SLOTS).
    maxWorkers: workerCount(),
    globalSetup: ['scripts/test-lock.mjs'],
    // Real git, terminals and peer-to-peer links: GitHub's runners (and a busy Mac) need longer than
    // vitest's 5 s, or a slow moment fails the release.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/cli.tsx', 'src/ui/components/**', 'src/ui/App.tsx', 'src/agent/runner.ts', 'src/core/clipboard.ts', 'src/ui/tty/clipboard.ts'],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 70 },
    },
  },
});
