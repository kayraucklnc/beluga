import type { AppState } from '@beluga/core/store.js';
import type { CcAgent, CcAgentStatus, CcSession } from '@beluga/core/claude-code/model.js';
import { sessionLive } from '@beluga/core/claude-code/model.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { tildePath } from '../lib/brand.js';

/**
 * Words, tones and groupings for Claude Code sessions running outside Beluga (the Activity place,
 * the strip above a workspace's chat, the Inspector). Pure helpers over the shared state.
 */

export type Tone = 'claude' | 'ok' | 'error' | 'warn' | 'muted';

const LABEL: Readonly<Record<CcAgentStatus, string>> = { running: 'Running', finished: 'Finished', failed: 'Failed', stopped: 'Stopped', idle: 'Idle' };
const TONE: Readonly<Record<CcAgentStatus, Tone>> = { running: 'claude', finished: 'ok', failed: 'error', stopped: 'muted', idle: 'warn' };

export const agentLabel = (a: Pick<CcAgent, 'status'>): string => LABEL[a.status];
export const agentTone = (a: Pick<CcAgent, 'status'>): Tone => TONE[a.status];

/** "45s", "12m", "1h 05m". */
export function since(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** How long it has worked (running) or worked (ended). */
export const agentElapsed = (a: CcAgent, now: number): string => since((a.status === 'running' ? now : (a.endedAt ?? a.lastAt)) - a.startedAt);

/** "Working · 12m", "Waiting for you", "Idle · 8m ago". */
export function sessionLabel(s: CcSession, now: number): { label: string; tone: Tone } {
  const running = s.agents.filter((a) => a.status === 'running').length;
  if (s.status === 'working') return { label: running ? `Working · ${plural(running, 'agent')} running` : 'Working', tone: 'claude' };
  if (running) return { label: `Waiting for ${running} agent${running === 1 ? '' : 's'}`, tone: 'claude' };
  if (s.status === 'waiting') return { label: 'Waiting for you', tone: 'ok' };
  return { label: `Quiet for ${since(now - s.lastAt)}`, tone: 'muted' };
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "6 agents running", "2 sessions", "Nothing running". */
export function activitySummary(sessions: readonly CcSession[]): string {
  const running = sessions.reduce((n, s) => n + s.agents.filter((a) => a.status === 'running').length, 0);
  const live = sessions.filter(sessionLive).length;
  if (running) return `${plural(running, 'agent')} running${live > 1 ? ` in ${plural(live, 'session')}` : ''}`;
  if (live) return `${plural(live, 'session')} working`;
  return sessions.length ? 'Nothing running right now' : 'No Claude Code sessions lately';
}

/** "~/code/api/madrid" for a path under your home folder. */
export const tildify = (state: Pick<AppState, 'home'>, p: string): string => tildePath(state.home, p);

/** Where it runs, in Beluga's words: the workspace's name, else the folder. */
export function placeLabel(state: Pick<AppState, 'projects' | 'home'>, s: CcSession): string {
  const ws = s.workspaceId ? state.projects.flatMap((p) => p.workspaces).find((w) => w.id === s.workspaceId) : undefined;
  return ws ? ws.name : tildify(state, s.cwd) || 'Unknown folder';
}

export interface ProjectGroup {
  readonly key: string;
  readonly projectId?: string;
  readonly name: string;
  readonly sessions: readonly CcSession[];
  readonly running: number;
}

/** Sessions by Beluga project (folders outside every project last, by their folder's name). */
export function groupByProject(state: Pick<AppState, 'projects'>, sessions: readonly CcSession[]): ProjectGroup[] {
  const groups = new Map<string, { projectId?: string; name: string; sessions: CcSession[] }>();
  for (const s of sessions) {
    const project = s.projectId ? state.projects.find((p) => p.id === s.projectId) : undefined;
    const key = project ? `p:${project.id}` : `d:${s.cwd}`;
    const name = project?.name ?? (s.cwd.split('/').filter(Boolean).pop() || 'Other');
    const g = groups.get(key) ?? { ...(project ? { projectId: project.id } : {}), name, sessions: [] };
    g.sessions.push(s);
    groups.set(key, g);
  }
  const runningIn = (x: CcSession): number => x.agents.filter((a) => a.status === 'running').length;
  for (const g of groups.values()) g.sessions.sort((a, b) => runningIn(b) - runningIn(a) || Number(sessionLive(b)) - Number(sessionLive(a)) || b.lastAt - a.lastAt);
  return [...groups]
    .map(([key, g]) => ({ key, ...g, running: g.sessions.reduce((n, s) => n + s.agents.filter((a) => a.status === 'running').length, 0) }))
    .sort((a, b) => Number(Boolean(b.projectId)) - Number(Boolean(a.projectId)) || b.running - a.running || a.name.localeCompare(b.name));
}

/** Go to the Activity place: everything, one session, or one agent. */
export function openActivity(client: SocketClient, session?: string, agent?: string): void {
  client.store.dispatch({ type: 'view', view: { kind: 'claude_code', ...(session ? { session } : {}), ...(agent ? { agent } : {}) } });
}

/** "general-purpose" → "General", "typescript-reviewer" → "TypeScript reviewer". */
export function typeLabel(type: string): string {
  if (type === 'general-purpose') return 'General';
  const words = type.split(/[-_]/).filter(Boolean);
  const fix = (w: string): string => ({ typescript: 'TypeScript', javascript: 'JavaScript', e2e: 'E2E', tdd: 'TDD', ui: 'UI', api: 'API' })[w.toLowerCase()] ?? w;
  return words.map((w, i) => (i === 0 ? fix(w).replace(/^./, (c) => c.toUpperCase()) : fix(w))).join(' ') || type;
}

/** "12.3k", "633k", "1.2M" tokens. */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
