import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
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
