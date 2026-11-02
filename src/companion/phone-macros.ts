import { z } from 'zod';
import { readJson, writeJson } from '../net/mesh/files.js';

/**
 * Saved phone flows (BLG-175): "do this on the phone" turned into a named, repeatable macro. A
 * macro is an ordered list of small steps; where it can, it acts on an element by the text it shows
 * (steady across runs) rather than raw pixels, so "open Strava and screenshot my stats" keeps
 * working when things move a little. Kept in ~/.beluga/phone-macros.json.
 */

export const MacroStep = z.discriminatedUnion('op', [
  z.object({ op: z.literal('open'), package: z.string().max(200).optional(), url: z.string().max(4000).optional() }),
  /** Tap the element that shows this text (or content-description / id), the steadiest way. */
  z.object({ op: z.literal('tapText'), text: z.string().min(1).max(200) }),
  z.object({ op: z.literal('tap'), x: z.number().int().min(0), y: z.number().int().min(0) }),
  z.object({ op: z.literal('type'), text: z.string().max(4000), enter: z.boolean().optional(), clear: z.boolean().optional() }),
  z.object({ op: z.literal('key'), key: z.string().max(40) }),
  z.object({ op: z.literal('swipe'), x1: z.number().int(), y1: z.number().int(), x2: z.number().int(), y2: z.number().int(), ms: z.number().int().min(50).max(5000).optional() }),
  z.object({ op: z.literal('scroll'), dir: z.enum(['up', 'down', 'left', 'right']) }),
  z.object({ op: z.literal('wait'), ms: z.number().int().min(100).max(20_000) }),
]);
export type MacroStep = z.infer<typeof MacroStep>;

export const Macro = z.object({
  name: z.string().min(1).max(60),
  steps: z.array(MacroStep).min(1).max(100),
  createdAt: z.number().int().min(0),
  /** Which phone it was recorded on (its model), for a friendly note; not a hard tie. */
  device: z.string().max(100).optional(),
});
export type Macro = z.infer<typeof Macro>;

const MAX_MACROS = 100;

export class PhoneMacros {
  private list: Macro[];

  constructor(private readonly file: string) {
    const raw = readJson(this.file);
    this.list = (Array.isArray(raw) ? raw : []).flatMap((m) => {
      const p = Macro.safeParse(m);
      return p.success ? [p.data] : [];
    });
  }

  all(): readonly Macro[] {
    return this.list;
  }

  get(name: string): Macro | undefined {
    const want = name.trim().toLowerCase();
    return this.list.find((m) => m.name.toLowerCase() === want);
  }

  /** Save (replacing one of the same name). Throws when the shelf is full. */
  save(macro: Macro): Macro {
    const parsed = Macro.parse(macro);
    const rest = this.list.filter((m) => m.name.toLowerCase() !== parsed.name.toLowerCase());
    if (rest.length >= MAX_MACROS) throw new Error(`You have ${MAX_MACROS} macros; delete one first`);
    this.list = [...rest, parsed];
    writeJson(this.file, this.list);
    return parsed;
  }

  remove(name: string): boolean {
    const before = this.list.length;
    this.list = this.list.filter((m) => m.name.toLowerCase() !== name.trim().toLowerCase());
    if (this.list.length === before) return false;
    writeJson(this.file, this.list);
    return true;
  }
}
