import { describe, expect, it } from 'vitest';
import { parseSetupFix } from '../src/agent/setup-fixer.js';

describe('parseSetupFix', () => {
  it('reads the last SETUP line', () => {
    expect(parseSetupFix('It has a pnpm lockfile.\nSETUP: pnpm install')).toEqual({ command: 'pnpm install' });
    expect(parseSetupFix('SETUP: npm ci\nOn second thought:\n`SETUP: bun install`')).toEqual({ command: 'bun install' });
  });

  it('knows when nothing needs to run', () => {
    expect(parseSetupFix('Nothing to install.\nSETUP: none')).toEqual({ none: true });
    expect(parseSetupFix('SETUP: None.')).toEqual({ none: true });
  });

  it('has no answer without a SETUP line', () => {
    expect(parseSetupFix('pnpm install')).toBeUndefined();
    expect(parseSetupFix('SETUP:')).toBeUndefined();
  });
});
