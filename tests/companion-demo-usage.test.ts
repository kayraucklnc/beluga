import { describe, expect, it } from 'vitest';
import { makeWorld } from '../packages/companion/lib/link/demo/data.js';
import { UsageView } from '../src/companion/protocol.js';

describe('the phone demo’s usage cards (BLG-459)', () => {
  it('has a card per provider in the shape its data has, Claude the default', () => {
    const usage = makeWorld(1_760_000_000_000).usage.map((u) => UsageView.parse(u));
    expect(usage.map((u) => [u.runtime, u.isDefault, u.windows.length > 0, Boolean(u.tokens)])).toEqual([
      ['claude', true, true, false],
      ['codex', false, true, false],
      ['local', false, false, true],
    ]);
  });
});
