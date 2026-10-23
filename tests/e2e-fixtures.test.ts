import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * There's no run-wide demo daemon: a spec file gets its own only through packages/mac/e2e/fixtures.ts
 * (which answers the page's /__klaud/endpoint). A spec taking `test` from @playwright/test runs
 * against no daemon at all, so every spec imports from './fixtures.js' (KLD-86).
 */
const E2E = path.resolve('packages/mac/e2e');

/** What's wrong with a spec's imports, if anything. */
function fixtureProblems(source: string): string[] {
  const problems: string[] = [];
  for (const m of source.matchAll(/import\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const [, names = '', from] = m;
    if (from === '@playwright/test' && /\btest\b/.test(names.replace(/\btype\s+\w+/g, ''))) problems.push('imports test from @playwright/test');
  }
  if (!/from\s+['"]\.\/fixtures\.js['"]/.test(source)) problems.push("doesn't import from ./fixtures.js");
  return problems;
}

describe('e2e specs use the per-worker fixtures', () => {
  const specs = readdirSync(E2E).filter((f) => f.endsWith('.spec.ts'));

  it('finds the specs', () => {
    expect(specs.length).toBeGreaterThan(10);
  });

  it.each(specs)('%s imports test from ./fixtures.js', (file) => {
    expect(fixtureProblems(readFileSync(path.join(E2E, file), 'utf8'))).toEqual([]);
  });

  it('catches a spec that takes test from @playwright/test', () => {
    expect(fixtureProblems("import { expect, test, type Page } from '@playwright/test';")).toEqual([
      'imports test from @playwright/test',
      "doesn't import from ./fixtures.js",
    ]);
    expect(fixtureProblems("import { test } from '@playwright/test';\nimport { sidebar } from './fixtures.js';")).toEqual(['imports test from @playwright/test']);
    expect(fixtureProblems("import { expect, test, type Page } from './fixtures.js';")).toEqual([]);
    expect(fixtureProblems("import { type TestInfo } from '@playwright/test';\nimport { test } from './fixtures.js';")).toEqual([]);
  });
});
