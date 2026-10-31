import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { API, type Method } from '../src/ipc/api.js';
import { parseArgs } from '../src/ipc/api.js';

/**
 * Over the daemon's socket a null argument arrives as undefined (JSON has no undefined, so
 * daemon/dispatch.ts reads every null as a left-out argument). An argument that takes null but not
 * undefined can never be sent as null from a screen: "Your agent" in the agent pickers failed so
 * (BLG-499). Such an argument must be nullish.
 */

// Already so before BLG-499 (Settings › Remove picture); kept apart, not hidden.
const KNOWN: readonly string[] = ['network.avatar.set'];

describe('API arguments that take null', () => {
  it('also take undefined, as null arrives over the socket', () => {
    const wrong: string[] = [];
    for (const method of Object.keys(API) as Method[]) {
      const items = (API[method].args as unknown as { def: { items: readonly z.ZodType[] } }).def.items;
      items.forEach((item, i) => {
        if (item.safeParse(null).success && !item.safeParse(undefined).success) wrong.push(`${method} #${i}`);
      });
    }
    expect(wrong.filter((w) => !KNOWN.some((k) => w.startsWith(`${k} `)))).toEqual([]);
  });

  it('"your default agent" (null) goes through as the daemon reads it', () => {
    const asDispatched = (raw: unknown[]) => raw.map((v) => (v === null ? undefined : v));
    expect(parseArgs('workbench.setAgent', asDispatched(['ws:abc', null]))).toEqual(['ws:abc', undefined]);
    expect(parseArgs('board.setAgent', asDispatched(['BOB-1', null]))).toEqual(['BOB-1', undefined]);
    expect(parseArgs('plans.setWorkAgent', asDispatched(['p1', null]))).toEqual(['p1', undefined]);
  });
});
