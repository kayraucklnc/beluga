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
  /**
   * Earlier outputs (and the trigger's payload) wrapped as material where they're filled in: a
   * Claude step's prompt gets them in tags (prompt.ts stepMaterial), so they're never instructions.
   */
  readonly material?: (kind: 'step' | 'trigger', name: string, text: string) => string;
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
      const json = JSON.stringify(ctx.trigger.payload !== undefined ? ctx.trigger.payload : { kind: ctx.trigger.kind, summary: ctx.trigger.summary }, null, 2);
      return ctx.material ? ctx.material('trigger', 'trigger', json) : json;
    }
    case 'previous':
      return ctx.previous === undefined ? '' : ctx.material ? ctx.material('step', ctx.previousName ?? 'previous', ctx.previous) : ctx.previous;
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
  return ctx.material ? ctx.material('step', found, text) : text;
}

/** "Mon 26 Oct 2026". */
export function dateText(at: number): string {
  const d = new Date(at);
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getFullYear()}`;
}
