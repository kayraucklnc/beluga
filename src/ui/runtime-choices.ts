import type { ModelChoice, RuntimeChoice } from '../core/work-store.js';

/** One other agent as the model picker lists it: greyed with what to do until it's ready, then its models. */
export interface RuntimeSection {
  readonly id: string;
  readonly label: string;
  /** Not ready: greyed out, saying why and what to do ("Not signed in · Run codex login in Terminal"). */
  readonly note?: string;
  readonly ready: boolean;
  readonly models: readonly ModelChoice[];
}

const WHY: Record<RuntimeChoice['state'], string> = { ready: '', signed_out: 'Not signed in', missing: 'Not installed' };

export function runtimeSections(runtimes: readonly RuntimeChoice[]): RuntimeSection[] {
  return runtimes.map((r) =>
    r.state === 'ready'
      ? { id: r.id, label: r.label, ready: true, models: r.models }
      : { id: r.id, label: r.label, ready: false, note: r.fix ? `${WHY[r.state]} · ${r.fix}` : WHY[r.state], models: [] },
  );
}
