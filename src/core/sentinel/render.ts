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
}

const SLOT = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function render(template: string, ctx: RenderContext): string {
  if (!template.includes('{{')) return template;
  return template.replace(SLOT, (whole, raw: string) => {
    const key = raw.trim();
    const value = valueOf(key, ctx);
    return value === undefined ? whole : value;
  });
}

function valueOf(key: string, ctx: RenderContext): string | undefined {
  switch (key.toLowerCase()) {
    case 'trigger':
      return ctx.trigger.summary;
    case 'trigger.json':
      return JSON.stringify(ctx.trigger.payload !== undefined ? ctx.trigger.payload : { kind: ctx.trigger.kind, summary: ctx.trigger.summary }, null, 2);
    case 'previous':
      return ctx.previous ?? '';
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
  if (Object.hasOwn(ctx.steps, step)) return ctx.steps[step];
  const lower = step.toLowerCase();
  const found = Object.keys(ctx.steps).find((n) => n.toLowerCase() === lower);
  return found === undefined ? undefined : ctx.steps[found];
}

/** "Mon 26 Oct 2026". */
export function dateText(at: number): string {
  const d = new Date(at);
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getFullYear()}`;
}
