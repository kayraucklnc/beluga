import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/core/commands.js';
import { METHODS } from '../src/ipc/api.js';

/**
 * Every way into klaud is listed in docs/parity.md with where each client shows it, so a feature
 * can't land in one client and be forgotten in the other.
 */
const doc = readFileSync('docs/parity.md', 'utf8');
const listed = (id: string): boolean => doc.includes(`\`${id}\``);

const uiActions = (): string[] => {
  const src = readFileSync('src/ui/workspace-models.ts', 'utf8');
  const block = src.slice(src.indexOf('export type UiAction ='), src.indexOf('export interface Model'));
  return [...new Set([...block.matchAll(/type: '([a-z_]+)'/g)].map((m) => m[1]!))];
};

const menuKinds = (): string[] =>
  [...new Set(['menus.ts', 'work-menus.ts', 'invite-menus.ts'].flatMap((f) => [...readFileSync(`src/ui/${f}`, 'utf8').matchAll(/kind: '([a-z_]+)'/g)].map((m) => m[1]!)))];

describe('docs/parity.md', () => {
  it('lists every slash command', () => {
    expect(COMMANDS.map((c) => `/${c.name}`).filter((c) => !listed(c))).toEqual([]);
  });

  it('lists every UI action', () => {
    expect(uiActions().filter((a) => !listed(a))).toEqual([]);
  });

  it('lists every menu', () => {
    expect(menuKinds().filter((k) => !listed(k))).toEqual([]);
  });

  it('lists every API method', () => {
    expect(METHODS.filter((m) => !listed(m))).toEqual([]);
  });
});
