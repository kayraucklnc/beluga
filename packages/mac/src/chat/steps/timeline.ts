import type { SubAgent } from '../../../../../src/core/store.js';
import type { StepSummary } from '../../../../../src/shared/steps.js';
import { keepSameById, keepSameLists } from '../../lib/stable.js';

/** One row of a card's steps: a step, or a sub-agent (background work) where it started. */
export type Entry = { readonly kind: 'step'; readonly id: string; readonly step: StepSummary } | { readonly kind: 'sub'; readonly id: string; readonly sub: SubAgent };

/** Still going: never folded away, so what's happening stays in sight. */
export const isLive = (e: Entry): boolean => (e.kind === 'sub' ? e.sub.status === 'running' : e.step.status === 'running');

/**
 * The steps with each sub-agent in the place it started: where its launching call is (launchedAt,
 * your own Claude's records), else when it started. Steps without real times (one-line steps of a
 * friend's Claude) all read as the card's start, so sub-agents go after them; so do ones kept
 * before sub-agents had a start.
 */
export function timelineOf(rows: readonly StepSummary[], subs: readonly SubAgent[], launchedAt: (id: string) => number | undefined): Entry[] {
  const placed = subs.map((sub) => ({ sub, at: launchedAt(sub.id) ?? sub.startedAt ?? Infinity })).sort((a, b) => a.at - b.at);
  const out: Entry[] = [];
  let next = 0;
  for (const step of rows) {
    while (next < placed.length && placed[next]!.at < step.startedAt) out.push(subEntry(placed[next++]!.sub));
    out.push({ kind: 'step', id: step.id, step });
  }
  while (next < placed.length) out.push(subEntry(placed[next++]!.sub));
  return out;
}

const subEntry = (sub: SubAgent): Entry => ({ kind: 'sub', id: `sub:${sub.id}`, sub });

/**
 * Which finished rows fold into "N steps · 12s": all but the last `keep` of them, once that's
 * more than one row (folding a single row hides nothing). Live rows always stay shown, in place.
 */
export function foldOf(entries: readonly Entry[], keep: number): { older: Entry[]; shown: Entry[] } {
  const done = entries.filter((e) => !isLive(e));
  if (done.length <= keep + 1) return { older: [], shown: [...entries] };
  const older = new Set(done.slice(0, done.length - keep));
  return { older: [...older], shown: entries.filter((e) => !older.has(e)) };
}

/**
 * Each sub-agent's own steps (your own Claude's records), a list kept the same object while its
 * steps are, so the sub-agent's row (memo) isn't drawn again for another step's news (KLD-72).
 */
export function ownStepsOf(prev: ReadonlyMap<string, readonly StepSummary[]> | undefined, rich: readonly StepSummary[] | undefined, subs: readonly SubAgent[]): ReadonlyMap<string, readonly StepSummary[]> {
  const next = new Map<string, readonly StepSummary[]>(subs.map((sub) => [sub.id, []]));
  for (const step of rich ?? []) if (step.parent && next.has(step.parent)) (next.get(step.parent) as StepSummary[]).push(step);
  // A fresh page of records is all new objects: the steps that read the same stay put.
  for (const [id, list] of next) next.set(id, keepSameById(prev?.get(id) ?? [], list));
  return keepSameLists(prev, next);
}

/**
 * What a sub-agent's row shows besides the sub-agent: plain values, so the row (memo) draws again
 * only when they change. Only an open row with a running step of its own follows the clock.
 */
export function subRowView(sub: SubAgent, own: readonly StepSummary[], isOpen: (id: string) => boolean, live: boolean, now: number): { open: boolean; opened: string; now: number } {
  const open = isOpen(`sub:${sub.id}`);
  return {
    open,
    opened: own.filter((x) => isOpen(x.id)).map((x) => x.id).join(' '),
    now: open && live && own.some((x) => x.status === 'running') ? now : 0,
  };
}

/**
 * Rows that change sides of the fold together (the answer landing lets more rows show; several
 * sub-agents finishing at once): more than one moves as one, without each sliding (KLD-72).
 */
export function movedTogether(before: readonly string[], after: readonly string[]): boolean {
  const was = new Set(before);
  const now = new Set(after);
  let moved = 0;
  for (const id of was) if (!now.has(id)) moved++;
  for (const id of now) if (!was.has(id)) moved++;
  return moved > 1;
}
