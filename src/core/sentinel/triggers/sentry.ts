import type { SentryTrigger } from '../model.js';
import { MINUTE, type FetchLike, type TriggerContext, type TriggerDeps, type TriggerEvent, clip, isObj, num, remember, startPolling, str, time } from './types.js';

/**
 * Sentry (docs/sentinel.md §1): the project's unresolved issues of the last day, polled every 2
 * minutes with $SENTRY_TOKEN (Settings › Environment).
 *
 * - **new issue**: an issue first seen after the cursor.
 * - **regression**: an unresolved issue whose substatus is `regressed` (once per regression: it
 *   fires again only after it stopped being one).
 * - **spike**: Sentry says `escalating`, or its events in the last hour are at least 10 and more
 *   than 5 times the hour before. Each issue's count is noted once an hour; an issue needs an hour
 *   behind it before its own rate can spike (until then only Sentry's `escalating` counts). Once
 *   per spike, like a regression.
 */

export interface SentryCursor {
  /** The newest first-seen time (ms). */
  readonly since: number;
  readonly seen: readonly string[];
  /** Regressed or spiking now (fired already). */
  readonly flagged: readonly string[];
  /** Each issue's count when the hour began, and the hour before's growth. */
  readonly hours: Readonly<Record<string, { readonly count: number; readonly at: number; readonly before?: number }>>;
}

export const SENTRY_EVERY_MS = 2 * MINUTE;
export const NO_SENTRY_TOKEN = 'Put SENTRY_TOKEN in Settings › Environment';
const HOUR = 60 * MINUTE;
const SPIKE_TIMES = 5;
const SPIKE_MIN = 10;

const WHAT: Readonly<Record<SentryTrigger['what'], string>> = { 'new-issue': '', regression: ' regression', spike: ' spike' };

export interface SentryIssue {
  readonly id: string;
  readonly title: string;
  readonly culprit?: string;
  readonly count: number;
  readonly permalink?: string;
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly substatus?: string;
  readonly level?: string;
  readonly shortId?: string;
}

export function parseSentryIssues(raw: unknown): SentryIssue[] {
  return (Array.isArray(raw) ? raw : []).filter(isObj).flatMap((r) => {
    const id = str(r.id);
    if (!id) return [];
    return [{ id, title: str(r.title) ?? 'An error', culprit: str(r.culprit), count: num(r.count) ?? 0, permalink: str(r.permalink), firstSeen: time(r.firstSeen), lastSeen: time(r.lastSeen), substatus: str(r.substatus), level: str(r.level), shortId: str(r.shortId) }];
  });
}

/** "TypeError: x is undefined" in "checkout" → "TypeError in checkout". */
const shortTitle = (i: SentryIssue): string => `${clip(i.title.split(':')[0] ?? i.title, 70)}${i.culprit ? ` in ${clip(i.culprit, 50)}` : ''}`;

function eventOf(t: SentryTrigger, i: SentryIssue, extra: Record<string, unknown> = {}): TriggerEvent {
  return {
    summary: clip(`Sentry${WHAT[t.what]}: ${shortTitle(i)}`, 130),
    payload: { event: t.what, project: `${t.org}/${t.project}`, id: i.id, shortId: i.shortId, title: i.title, culprit: i.culprit, count: i.count, level: i.level, permalink: i.permalink, firstSeen: new Date(i.firstSeen).toISOString(), lastSeen: new Date(i.lastSeen).toISOString(), ...extra },
  };
}

/** The issues against the cursor: what fires (oldest first) and the next cursor. The first look fires nothing. */
export function sentryStep(t: SentryTrigger, issues: readonly SentryIssue[], cursor: SentryCursor | undefined, now: number): { readonly events: TriggerEvent[]; readonly cursor: SentryCursor } {
  const newest = issues.reduce((m, i) => Math.max(m, i.firstSeen), 0);
  // The hourly counts, rolled over once an hour (only for the issues still listed).
  const hours: Record<string, { count: number; at: number; before?: number }> = {};
  for (const i of issues) {
    const h = cursor?.hours[i.id];
    if (!h) hours[i.id] = { count: i.count, at: now };
    else if (now - h.at >= HOUR) hours[i.id] = { count: i.count, at: now, before: i.count - h.count };
    else hours[i.id] = h;
  }
  const spiking = (i: SentryIssue): boolean => {
    if (i.substatus === 'escalating') return true;
    const h = cursor?.hours[i.id];
    if (!h || h.before === undefined) return false;
    const growth = i.count - h.count;
    return growth >= SPIKE_MIN && growth > SPIKE_TIMES * Math.max(1, h.before);
  };
  const flaggedNow = issues.filter((i) => (t.what === 'regression' ? i.substatus === 'regressed' : t.what === 'spike' ? spiking(i) : false)).map((i) => i.id);
  if (!cursor) return { events: [], cursor: { since: newest || now, seen: remember([], issues.map((i) => i.id)), flagged: flaggedNow, hours } };
  const events: TriggerEvent[] = [];
  if (t.what === 'new-issue') {
    const seen = new Set(cursor.seen);
    for (const i of [...issues].sort((a, b) => a.firstSeen - b.firstSeen)) if (!seen.has(i.id) && i.firstSeen > cursor.since) events.push(eventOf(t, i));
  } else {
    const was = new Set(cursor.flagged);
    for (const id of flaggedNow) {
      if (was.has(id)) continue;
      const i = issues.find((x) => x.id === id)!;
      const h = cursor.hours[id];
      events.push(eventOf(t, i, t.what === 'spike' ? { lastHour: h ? i.count - h.count : undefined, hourBefore: h?.before, escalating: i.substatus === 'escalating' } : {}));
    }
  }
  return { events, cursor: { since: Math.max(cursor.since, newest), seen: remember(cursor.seen, issues.map((i) => i.id)), flagged: flaggedNow, hours } };
}

class SentryTrouble extends Error {}

export async function fetchSentry(t: SentryTrigger, token: string, fetchFn: FetchLike, base = 'https://sentry.io'): Promise<SentryIssue[]> {
  const url = `${base}/api/0/projects/${encodeURIComponent(t.org)}/${encodeURIComponent(t.project)}/issues/?query=is:unresolved&sort=date&statsPeriod=24h`;
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 401 || res.status === 403) throw new SentryTrouble('Sentry doesn’t accept SENTRY_TOKEN: make a token that can read the project (project:read, event:read) and put it in Settings › Environment');
  if (res.status === 404) throw new SentryTrouble(`Sentry has no project ${t.org}/${t.project} for this token: check the organization and project names`);
  if (res.status >= 400) throw new Error(`Sentry answered ${res.status}`);
  try {
    return parseSentryIssues(JSON.parse(await res.text()) as unknown);
  } catch {
    throw new Error('Sentry gave an answer Beluga doesn’t understand');
  }
}

export function startSentry(t: SentryTrigger, ctx: TriggerContext<SentryCursor>, deps: TriggerDeps, base?: string): () => void {
  const now = deps.now ?? Date.now;
  return startPolling(
    ctx,
    async () => {
      const token = deps.env?.(ctx.sentinel.projectId).SENTRY_TOKEN?.trim();
      if (!token) return NO_SENTRY_TOKEN;
      if (!deps.fetch) return 'Sentry needs the Beluga app';
      if (!t.org || !t.project) return 'Say which Sentry organization and project to watch';
      try {
        const issues = await fetchSentry(t, token, deps.fetch, base);
        const { events, cursor } = sentryStep(t, issues, ctx.cursor(), now());
        ctx.save(cursor);
        for (const e of events) ctx.fire(e);
        return undefined;
      } catch (err) {
        if (err instanceof SentryTrouble) return err.message;
        throw err;
      }
    },
    { everyMs: SENTRY_EVERY_MS, failing: 'Sentry didn’t answer' },
  );
}
