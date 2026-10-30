/**
 * The runtimes an agent picker shows (BLG-446), whether this Mac runs them or not: one this Mac
 * can't run yet stays in the list, greyed, saying what's missing, instead of disappearing.
 * Browser-safe and dependency-free: the daemon, the Mac app and the phone import it.
 */

/** A model a runtime offers (core/work-store.ts ModelChoice has the same shape). */
export interface RuntimeModel {
  /** Passed to the runtime (an alias like "sonnet", or a full id); '' = the runtime's own default. */
  readonly value: string;
  readonly label: string;
  readonly description: string;
  readonly efforts?: readonly string[];
  /** Can't be picked now, and why (a local endpoint that isn't answering). */
  readonly why?: string;
}

/** A runtime as a picker shows it: its models when it runs here, why not when it doesn't. */
export interface RuntimeChoice {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  /** Not available: what's missing, in plain words ("Codex isn't installed on this Mac"). */
  readonly why?: string;
  /** Its models (Claude's come from Claude Code itself: the state's `models`). */
  readonly models?: readonly RuntimeModel[];
}

/** Every runtime Beluga knows of, in picker order, with what's missing when it isn't set up. */
export const KNOWN_RUNTIMES: ReadonlyArray<{ readonly id: string; readonly label: string; readonly missing: string }> = [
  { id: 'claude', label: 'Claude', missing: "Claude Code isn't signed in on this Mac" },
  { id: 'codex', label: 'Codex', missing: "Codex isn't set up on this Mac yet" },
  { id: 'local', label: 'Local model', missing: 'No local model endpoint is set' },
];

/** The runtimes as a picker lists them, given which ones run here (and their models, when known). */
export function runtimeChoices(runs: (id: string) => { readonly models?: readonly RuntimeModel[] } | undefined): RuntimeChoice[] {
  return KNOWN_RUNTIMES.map((r) => {
    const here = runs(r.id);
    return here ? { id: r.id, label: r.label, available: true, ...(here.models ? { models: here.models } : {}) } : { id: r.id, label: r.label, available: false, why: r.missing };
  });
}
