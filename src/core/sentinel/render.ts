import { PAYLOAD_MAX, capPayload } from './model.js';

/**
 * A step's templates (docs/sentinel.md §4): `{{trigger}}`, `{{trigger.json}}`, `{{previous}}`,
 * `{{steps.<name>}}`, `{{project}}`, `{{project.path}}`, `{{date}}`, `{{sentinel}}`, and Beluga's
 * own `{{tasks}}`, `{{worktrees}}`, `{{plans}}`. Unknown ones stay as written. Pure.
 */

export interface RenderContext {
  readonly trigger: { readonly kind: string; readonly summary: string; readonly payload?: unknown };
  /** The step before's output. */
  readonly previous?: string;
  /** Earlier steps' outputs by their names. */
  readonly steps?: Readonly<Record<string, string>>;
  /** None: Your Mac. */
  readonly project?: { readonly name: string; readonly path?: string };
  /** Today, in words ("Mon 26 Oct 2026"). */
  readonly date: string;
  readonly sentinel: string;
  readonly tasks?: string;
  readonly worktrees?: string;
  readonly plans?: string;
  /** The step before's name (for `material`). */
  readonly previousName?: string;
  /** Where the step before's whole output is on disk (the run's folder; none in memory). */
  readonly previousFile?: string;
  /** Where earlier steps' whole outputs are, by their names. */
  readonly stepFiles?: Readonly<Record<string, string>>;
  /**
   * Earlier outputs (and the trigger's payload) wrapped as material where they're filled in: a
   * Claude step's prompt gets them in tags (prompt.ts stepMaterial), so they're never instructions;
   * a big one there is its file's path and a preview (`file`: where it is, when it's on disk).
   */
  readonly material?: (kind: 'step' | 'trigger', name: string, text: string, file?: string) => string;
  /** Every value filled in goes through this (a JSON body gets them as JSON string contents). */
  readonly escape?: (text: string) => string;
}

/** A value as the inside of a JSON string ("say \"hi\"" without its quotes). */
export const jsonInside = (text: string): string => JSON.stringify(text).slice(1, -1);

const SLOT = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function render(template: string, ctx: RenderContext): string {
  if (!template.includes('{{')) return template;
  return template.replace(SLOT, (whole, raw: string) => {
    const key = raw.trim();
    const value = valueOf(key, ctx);
    return value === undefined ? whole : ctx.escape ? ctx.escape(value) : value;
  });
}

function valueOf(key: string, ctx: RenderContext): string | undefined {
  switch (key.toLowerCase()) {
    case 'trigger':
      return ctx.trigger.summary;
    case 'trigger.json': {
      const value = ctx.trigger.payload !== undefined ? capPayload(ctx.trigger.payload) : { kind: ctx.trigger.kind, summary: ctx.trigger.summary };
      // Indented when that still fits in 64 KB; a big payload goes as it is.
      const pretty = JSON.stringify(value, null, 2);
      const json = pretty.length > PAYLOAD_MAX ? JSON.stringify(value) : pretty;
      return ctx.material ? ctx.material('trigger', 'trigger', json) : json;
    }
    case 'previous':
      return ctx.previous === undefined ? '' : ctx.material ? ctx.material('step', ctx.previousName ?? 'previous', ctx.previous, ctx.previousFile) : ctx.previous;
    case 'project':
      return ctx.project?.name ?? 'Your Mac';
    case 'project.path':
      return ctx.project?.path ?? '~';
    case 'date':
      return ctx.date;
    case 'sentinel':
      return ctx.sentinel;
    case 'tasks':
      return ctx.tasks ?? '';
    case 'worktrees':
      return ctx.worktrees ?? '';
    case 'plans':
      return ctx.plans ?? '';
  }
  const step = /^steps\.(.+)$/i.exec(key)?.[1]?.trim();
  if (step === undefined || !ctx.steps) return undefined;
  const lower = step.toLowerCase();
  const found = Object.hasOwn(ctx.steps, step) ? step : Object.keys(ctx.steps).find((n) => n.toLowerCase() === lower);
  if (found === undefined) return undefined;
  const text = ctx.steps[found]!;
  return ctx.material ? ctx.material('step', found, text, ctx.stepFiles?.[found]) : text;
}

/** "Mon 26 Oct 2026". */
export function dateText(at: number): string {
  const d = new Date(at);
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getFullYear()}`;
}
