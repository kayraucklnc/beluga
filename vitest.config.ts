import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/cli.tsx', 'src/ui/components/**', 'src/ui/App.tsx', 'src/agent/runner.ts', 'src/core/clipboard.ts', 'src/ui/tty/clipboard.ts'],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 70 },
    },
  },
});
