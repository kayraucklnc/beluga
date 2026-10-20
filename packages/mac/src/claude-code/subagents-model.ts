import type { AgentOrigin, CcAgent, CcSession } from '../../../../src/core/claude-code/model.js';
import type { AppState } from '../../../../src/core/store.js';
import type { Workspace } from '../../../../src/workspaces/types.js';
import { worktreeOrigin } from '../../../../src/workspaces/origin.js';

/**
 * Sub-agents as the Mac app shows them: Claude's helpers, never your own work. Each is tied to
 * the conversation that started it (a Klaud worktree's chat, or a Claude Code session outside
 * Klaud), with its own worktree when it was started in isolation. Pure: no React, no daemon
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

/** Every sub-agent being watched, newest first within each session. */
export function allSubAgents(sessions: readonly CcSession[]): SubAgent[] {
  return sessions.flatMap((session) => session.agents.map((agent) => ({ agent, session })));
}

/** The sub-agent working in a worktree (by the worktree Claude Code recorded, else by the folder's name). */
export function agentOfWorktree(sessions: readonly CcSession[], w: Pick<Workspace, 'path'>): SubAgent | undefined {
  const id = agentIdOfPath(w.path);
  return allSubAgents(sessions).find(({ agent }) => agent.worktree?.path === w.path || (id !== undefined && agent.id === id));
}

/** The sub-agent Klaud's chat knows by the tool call that started it. */
export const agentOfToolUse = (sessions: readonly CcSession[], toolUseId: string): SubAgent | undefined => allSubAgents(sessions).find(({ agent }) => agent.toolUseId === toolUseId);

/** Where a sub-agent's conversation is in Klaud: the workspace whose chat started it (Klaud's own), or the folder its session runs in. */
export function parentWorkspace(state: Pick<AppState, 'projects'>, s: SubAgent): Workspace | undefined {
  if (!s.session.workspaceId) return undefined;
  return state.projects.flatMap((p) => p.workspaces).find((w) => w.id === s.session.workspaceId && !w.archived);
}

/** Can you steer it (through the Claude that started it)? Only when that Claude is one of Klaud's conversations. */
export const steerable = (s: SubAgent): boolean => Boolean(s.session.own && s.session.workspaceId);

/**
 * The rows nested under a workspace in the sidebar: the sub-agents its conversation started,
 * running first; finished ones whose worktree is still there stay (from Claude Code's files).
 */
export function subAgentsUnder(sessions: readonly CcSession[], workspaceId: string, origins: readonly AgentOrigin[] = []): SubAgent[] {
  const live = allSubAgents(sessions).filter((s) => s.session.workspaceId === workspaceId && !s.agent.parentAgentId);
  const followed = new Set(allSubAgents(sessions).flatMap((s) => [s.agent.id, ...(s.agent.worktree ? [s.agent.worktree.path] : [])]));
  const past = origins.filter((o) => o.workspaceId === workspaceId && !followed.has(o.agentId) && !followed.has(o.path)).map(pastAgent);
  return [...live, ...past].sort((a, b) => Number(b.agent.status === 'running') - Number(a.agent.status === 'running') || b.agent.lastAt - a.agent.lastAt);
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
