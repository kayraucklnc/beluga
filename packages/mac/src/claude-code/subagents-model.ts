import type { AgentOrigin, CcAgent, CcSession } from '../../../../src/core/claude-code/model.js';
import type { AppState } from '../../../../src/core/store.js';
import type { Workspace } from '../../../../src/workspaces/types.js';
import { worktreeOrigin } from '../../../../src/workspaces/origin.js';

/**
 * Sub-agents as the Mac app shows them: Claude's helpers, never your own work. Each is tied to
 * the conversation that started it (a Beluga worktree's chat, or a Claude Code session outside
 * Beluga), with its own worktree when it was started in isolation. Pure: no React, no daemon
 * (tests/mac-subagents.test.ts).
 */

/** One sub-agent with the session that started it. */
export interface SubAgent {
  readonly agent: CcAgent;
  readonly session: CcSession;
  /** Finished a while ago: known from Claude Code's files (its worktree is still there), not followed live. */
  readonly past?: true;
}

/** A finished sub-agent's worktree, as the sub-agent it was (what it was asked, who started it). */
export function pastAgent(o: AgentOrigin): SubAgent {
  const agent: CcAgent = { id: o.agentId, description: o.description ?? 'Sub-agent', type: o.type ?? 'general-purpose', background: true, status: 'finished', startedAt: o.lastAt, lastAt: o.lastAt, steps: 0, worktree: { path: o.path, ...(o.branch ? { branch: o.branch } : {}) } };
  const session: CcSession = { id: o.sessionId, title: o.sessionTitle ?? 'Claude Code session', cwd: o.sessionCwd ?? '', status: 'idle', lastAt: o.lastAt, steps: 0, agents: [agent], ...(o.projectId ? { projectId: o.projectId } : {}), ...(o.workspaceId ? { workspaceId: o.workspaceId } : {}), ...(o.own ? { own: true as const } : {}) };
  return { agent, session, past: true };
}

/** A sub-agent's worktree folder name → its agent id (`agent-a09dac5d30f83f08a` → `a09dac5d30f83f08a`). */
export const agentIdOfPath = (p: string): string | undefined => /[\\/]\.claude[\\/]worktrees[\\/]agent-([\w-]+)\/?$/.exec(p)?.[1];

/** Is this worktree one a sub-agent made for itself? */
export const isAgentWorktree = (w: Pick<Workspace, 'path' | 'kind' | 'external'>): boolean => w.kind === 'worktree' && worktreeOrigin(w) === 'agent';

/** Every sub-agent being watched, session by session. */
export function allSubAgents(sessions: readonly CcSession[]): SubAgent[] {
  return sessions.flatMap((session) => session.agents.map((agent) => ({ agent, session })));
}

/** The sub-agent working in a worktree (by the worktree Claude Code recorded, else by the folder's name). */
export function agentOfWorktree(sessions: readonly CcSession[], w: Pick<Workspace, 'path'>): SubAgent | undefined {
  const id = agentIdOfPath(w.path);
  return allSubAgents(sessions).find(({ agent }) => agent.worktree?.path === w.path || (id !== undefined && agent.id === id));
}

/** The sub-agent Beluga's chat knows by the tool call that started it. */
export const agentOfToolUse = (sessions: readonly CcSession[], toolUseId: string): SubAgent | undefined => allSubAgents(sessions).find(({ agent }) => agent.toolUseId === toolUseId);

/** Where a sub-agent's conversation is in Beluga: the workspace whose chat started it (Beluga's own), or the folder its session runs in. */
export function parentWorkspace(state: Pick<AppState, 'projects'>, s: SubAgent): Workspace | undefined {
  if (!s.session.workspaceId) return undefined;
  return state.projects.flatMap((p) => p.workspaces).find((w) => w.id === s.session.workspaceId && !w.archived);
}

/** Can you steer it (through the Claude that started it)? Only when that Claude is one of Beluga's conversations. */
export const steerable = (s: SubAgent): boolean => Boolean(s.session.own && s.session.workspaceId);

/**
 * The one order sub-agents are listed in, everywhere: when they started (newest last), then by
 * id. Nothing that changes while they work (status, last write) moves a row (BLG-21).
 */
export const byStart = (a: Pick<CcAgent, 'startedAt' | 'id'>, b: Pick<CcAgent, 'startedAt' | 'id'>): number => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Agents in that order (a new array; the given one is left as it is). */
export const inStartOrder = <T extends Pick<CcAgent, 'startedAt' | 'id'>>(agents: readonly T[]): T[] => [...agents].sort(byStart);

/**
 * Which of a list (in start order) show when only `cap` fit: the newest `cap`, plus any `keep`
 * says must show (the one you're looking at), still in start order. Only a new agent starting
 * (or you picking another) changes the set: an agent finishing never hides or moves a row.
 */
export function cappedAgents<T>(list: readonly T[], cap: number, keep: (x: T) => boolean = () => false): { shown: T[]; hidden: number } {
  const from = Math.max(0, list.length - cap);
  const shown = list.filter((x, i) => i >= from || keep(x));
  return { shown, hidden: list.length - shown.length };
}

/** A folded group of sub-agents, in words: "4 sub-agents · 1 running". */
export function subAgentsSummary(list: readonly Pick<SubAgent, 'agent'>[]): string {
  const running = list.filter((s) => s.agent.status === 'running').length;
  return `${list.length} sub-agent${list.length === 1 ? '' : 's'}${running ? ` · ${running} running` : ''}`;
}

/**
 * The rows nested under a workspace in the sidebar: the sub-agents its conversation started, in
 * start order (newest last); finished ones whose worktree is still there stay (from Claude Code's files).
 */
export function subAgentsUnder(sessions: readonly CcSession[], workspaceId: string, origins: readonly AgentOrigin[] = []): SubAgent[] {
  const live = allSubAgents(sessions).filter((s) => s.session.workspaceId === workspaceId && !s.agent.parentAgentId);
  const followed = new Set(allSubAgents(sessions).flatMap((s) => [s.agent.id, ...(s.agent.worktree ? [s.agent.worktree.path] : [])]));
  const past = origins.filter((o) => o.workspaceId === workspaceId && !followed.has(o.agentId) && !followed.has(o.path)).map(pastAgent);
  return [...live, ...past].sort((a, b) => byStart(a.agent, b.agent));
}

/**
 * What a sub-agent left behind, in words. One started in its own worktree leaves that worktree
 * (Claude Code removes it only when the agent changed nothing): its commits and uncommitted
 * files are what's left. One without a worktree worked in the folder of the conversation that
 * started it: whatever it changed is among that folder's changes, nothing of its own.
 */
export interface Residue {
  /** 'none': nothing left; 'some': commits or uncommitted files; 'shared': worked in its parent's folder; 'unknown': not checked yet. */
  readonly kind: 'none' | 'some' | 'shared' | 'unknown';
  readonly commits: number;
  readonly files: number;
  /** Short, for the row ("2 commits · 1 file", "Nothing left"). */
  readonly short: string;
  /** The whole sentence (a tooltip). */
  readonly long: string;
  /** Done, and clearing it loses nothing (its worktree has no commits or changes, or it never had one). */
  readonly clearable: boolean;
}

const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What `s` left: from its worktree's git status (`worktree`: the workspace at its worktree's path, if Beluga has it). */
export function agentResidue(s: SubAgent, worktree?: Pick<Workspace, 'status'>): Residue {
  const done = s.agent.status !== 'running' && s.agent.status !== 'idle';
  if (!s.agent.worktree) {
    return { kind: 'shared', commits: 0, files: 0, short: done ? 'Nothing of its own' : '', long: 'Worked in the folder of the conversation that started it: anything it changed is in that folder’s changes, nothing separate to clean up.', clearable: done };
  }
  // Its worktree is gone already (removed or archived): nothing left here.
  if (!worktree) return { kind: 'none', commits: 0, files: 0, short: 'Nothing left', long: 'Its worktree is gone: nothing left behind.', clearable: done };
  const st = worktree.status;
  if (!st) return { kind: 'unknown', commits: 0, files: 0, short: 'Checking…', long: 'Its worktree hasn’t been looked at yet.', clearable: false };
  const parts = [st.ahead ? count(st.ahead, 'commit') : '', st.changed ? count(st.changed, 'file') : ''].filter(Boolean);
  if (!parts.length) return { kind: 'none', commits: 0, files: 0, short: 'Nothing left', long: 'Its worktree has no commits that aren’t in main and no uncommitted files: safe to clear.', clearable: done };
  const long = [st.ahead ? `${count(st.ahead, 'commit')} not in main` : '', st.changed ? count(st.changed, 'uncommitted file') : ''].filter(Boolean).join(' and ');
  return { kind: 'some', commits: st.ahead, files: st.changed, short: parts.join(' · '), long: `Left ${long} in its worktree${s.agent.worktree.branch ? ` (branch ${s.agent.worktree.branch})` : ''}. Archiving it keeps them.`, clearable: false };
}

/** "claude-opus-5-5" → "Opus 5.5", "sonnet" → "Sonnet", anything else as it is. */
export function modelLabel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i.exec(model);
  if (m) return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1).toLowerCase()} ${m[2]}${m[3] && m[3].length <= 2 ? `.${m[3]}` : ''}`;
  if (/^(opus|sonnet|haiku|fable)$/i.test(model)) return `${model[0]!.toUpperCase()}${model.slice(1).toLowerCase()}`;
  return model;
}

/** "medium" → "Medium effort". */
export const effortLabel = (effort: string | undefined): string | undefined => (effort ? `${effort[0]!.toUpperCase()}${effort.slice(1)} effort` : undefined);

/** What a sub-agent is called in a list: what it was asked to do, else its name, else a short id. */
export const agentTitle = (a: Pick<CcAgent, 'description' | 'name' | 'id'>): string => (a.description && a.description !== 'Sub-agent' ? a.description : (a.name ?? `Agent ${a.id.slice(0, 7)}`));

/** Who to tell: the agent's name when it has one (SendMessage takes it), else its id. */
export const addressOf = (a: Pick<CcAgent, 'name' | 'id'>): string => a.name ?? a.id;

/**
 * What you ask the Claude that started a sub-agent, to pass something on to it. You never talk
 * to a sub-agent yourself: its lead Claude decides how to tell it (SendMessage), so the
 * conversation stays one story.
 */
export function steerPrompt(a: Pick<CcAgent, 'description' | 'name' | 'id' | 'status'>, text: string): string {
  const who = `your sub-agent “${agentTitle(a)}” (${a.name ? `name ${a.name}, ` : ''}agent id ${a.id})`;
  const how = a.status === 'running' ? `Pass this on to it now with SendMessage (to: "${addressOf(a)}")` : `It has stopped; continue it with SendMessage (to: "${addressOf(a)}") and this`;
  return `About ${who}: ${text.trim()}\n\n${how}, then carry on. Tell me in one line what you told it.`;
}
