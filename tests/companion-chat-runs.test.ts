import { describe, expect, it } from 'vitest';
import { runOf } from '../packages/companion/lib/chat-runs.js';

/** The phone's chat groups messages into runs like the Mac's (BLG-210): packages/companion/lib/chat-runs.ts. */

const m = (from: string, ts: number, extra: { mine?: boolean; claude?: boolean; task?: object } = {}) => ({ from, ts, mine: extra.mine ?? false, ...extra });
const T = 1_760_000_000_000;

describe('runs on the phone', () => {
  it('runs one person’s messages within a few minutes: the name on the first, the picture and time on the last', () => {
    const list = [m('ata', T), m('ata', T + 60_000), m('you', T + 70_000, { mine: true }), m('you', T + 80_000, { mine: true }), m('ata', T + 90_000), m('ata', T + 20 * 60_000)];
    expect(list.map((_, i) => runOf(list, i))).toEqual([
      { first: true, last: false },
      { first: false, last: true },
      { first: true, last: false },
      { first: false, last: true },
      { first: true, last: true },
      { first: true, last: true },
    ]);
  });

  it('keeps a person and their Claude apart, and a task’s card on its own', () => {
    const list = [m('ata', T), m('ata', T + 1000, { claude: true }), m('ata', T + 2000, { claude: true }), m('ata', T + 3000, { task: {} }), m('ata', T + 4000)];
    expect(list.map((_, i) => runOf(list, i))).toEqual([
      { first: true, last: true },
      { first: true, last: false },
      { first: false, last: true },
      { first: true, last: true },
      { first: true, last: true },
    ]);
  });
});
