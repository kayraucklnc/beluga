import { useMemo } from 'react';
import type { CcSession } from '@klaud/core/claude-code/model.js';
import type { Project, Workspace } from '@klaud/workspaces/types.js';
import type { SocketClient } from '@klaud/ipc/socket-client.js';
import { Icon } from '../components/Icon.js';
import { Dot, cx } from '../components/ui.js';
import { type Actions, useActions } from '../lib/actions.js';
import { useApp, useKlaud, useUi } from '../lib/klaud.js';
import { agentElapsed, agentLabel, openActivity, typeLabel } from '../claude-code/cc-model.js';
import { type SubAgent, agentIdOfPath, agentOfWorktree, agentTitle, isAgentWorktree, looseAgentWorktrees, modelLabel, subAgentsUnder } from '../claude-code/subagents-model.js';
import { useNow } from '../chat/Items.js';
import { Row } from './sidebar-parts.js';
import s from './subagents.module.css';

/**
 * Sub-agents in the sidebar: Claude's helpers, not your work. They sit under the conversation
 * that started them (a small robot, quieter than a worktree), running ones first; a few show,
 * the rest behind "N more". Their own worktrees aren't listed as worktrees: they open as the
 * agent. Sub-agent worktrees nobody started from here wait in one folded "Sub-agents" row.
 */

/** How many of a conversation's sub-agents show before "N more". */
const SHOWN = 3;

/** The watched sessions, as the state has them (one array: no new one each render). */
export const useCcSessions = (): readonly CcSession[] => useApp((st) => st.claudeCode.sessions);

/** Open a sub-agent: its worktree (with Changes, Files and Scratch beside it) when it has one, else its live page. */
export function openSubAgent(client: SocketClient, actions: Actions, s: SubAgent): void {
  const path = s.agent.worktree?.path;
  const ws = path ? client.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.path === path && !w.archived) : undefined;
  if (ws) actions.run({ type: 'open_ws', id: ws.id });
  else openActivity(client, s.session.id, s.agent.id);
}

function useSelectedAgent(): { ws?: string; agent?: string } {
  const view = useApp((st) => st.view);
  if (view.kind === 'workspace') return { ws: view.id };
  if (view.kind === 'claude_code' && view.agent) return { agent: view.agent };
  return {};
}

function AgentMark({ status }: { status: SubAgent['agent']['status'] }) {
  if (status === 'running') return <Dot tone="claude" live />;
  return <Icon name={status === 'failed' ? 'x' : status === 'finished' ? 'check' : status === 'idle' ? 'clock' : 'stop'} size={10} className={cx(s.mark, status === 'failed' && s.markFailed)} />;
}

function AgentRow({ s: sub, indent, worktree }: { s: SubAgent; indent: number; worktree?: Workspace }) {
  const { client } = useKlaud();
  const actions = useActions();
  const selected = useSelectedAgent();
  const now = useNow(sub.agent.status === 'running');
  const a = sub.agent;
  const on = selected.agent === a.id || (worktree !== undefined && selected.ws === worktree.id);
  const facts = [typeLabel(a.type), modelLabel(a.model), agentLabel(a), agentElapsed(a, now)].filter(Boolean).join(' · ');
  return (
    <Row
      data-subagent={a.id}
      indent={indent}
      selected={on}
      className={cx(s.row, a.status !== 'running' && s.quiet)}
      icon={<Icon name="bot" size={13} className={s.bot} />}
      aria-label={`Sub-agent ${agentTitle(a)}, ${agentLabel(a)}`}
      label={<span className={s.label}>{agentTitle(a)}</span>}
      detail={`Sub-agent: ${agentTitle(a)} · ${facts}${a.worktree ? ' · in its own worktree' : ''}`}
      onClick={() => openSubAgent(client, actions, sub)}
      trailing={<AgentMark status={a.status} />}
    />
  );
}

/** Under a conversation's row: the sub-agents it started. */
export function SubAgentRows({ ws, indent }: { ws: Workspace; indent: number }) {
  const actions = useActions();
  const sessions = useCcSessions();
  const projects = useApp((st) => st.projects);
  const key = `subagents-more:${ws.id}`;
  const expanded = useUi((u) => u.collapsed.includes(key));
  const list = useMemo(() => subAgentsUnder(sessions, ws.id), [sessions, ws.id]);
  const selected = useSelectedAgent();
  if (!list.length) return null;
  const worktreeOf = (sub: SubAgent): Workspace | undefined => (sub.agent.worktree ? projects.flatMap((p) => p.workspaces).find((w) => w.path === sub.agent.worktree!.path) : undefined);
  // The one you're looking at always shows, even when it's among the tucked-away ones.
  const isOn = (sub: SubAgent): boolean => selected.agent === sub.agent.id || (selected.ws !== undefined && worktreeOf(sub)?.id === selected.ws);
  const shown = expanded ? list : list.filter((sub, i) => i < SHOWN || isOn(sub));
  const hidden = list.length - shown.length;
  return (
    <div role="group" aria-label={`Sub-agents of ${ws.name}`}>
      {shown.map((sub) => {
        const wt = worktreeOf(sub);
        return <AgentRow key={`${sub.session.id}:${sub.agent.id}`} s={sub} indent={indent} {...(wt ? { worktree: wt } : {})} />;
      })}
      {hidden > 0 || expanded ? (
        <Row
          indent={indent}
          className={cx(s.row, s.more)}
          icon={<span className={s.moreDot} />}
          label={expanded && hidden === 0 ? 'Show Fewer' : `${hidden} more sub-agent${hidden === 1 ? '' : 's'}`}
          onClick={() => actions.run({ type: 'toggle_fold', key })}
        />
      ) : null}
    </div>
  );
}

/** A project's sub-agent worktrees that no conversation here shows (old ones, or from outside Klaud): one folded row. */
export function LooseSubAgents({ p, indent, shownUnder }: { p: Project; indent: number; shownUnder: (wsId: string) => boolean }) {
  const actions = useActions();
  const sessions = useCcSessions();
  const selected = useSelectedAgent();
  const key = `subagents:${p.id}`;
  const open = useUi((u) => u.collapsed.includes(key));
  const list = useMemo(() => looseAgentWorktrees(p, sessions, shownUnder), [p, sessions, shownUnder]);
  if (!list.length) return null;
  const here = list.find((w) => w.id === selected.ws);
  const shown = open ? list : here ? [here] : [];
  return (
    <div role="group" aria-label={`Sub-agent worktrees in ${p.name}`}>
      <Row
        indent={indent}
        className={cx(s.row, s.folder)}
        aria-expanded={open}
        icon={<Icon name="chevronRight" size={9} className={cx(s.disclosure, open && s.disclosureOpen)} />}
        label={
          <span className={s.label}>
            Sub-agents <span className={s.count}>{list.length}</span>
          </span>
        }
        detail="Worktrees Claude’s sub-agents made for themselves. They’re Claude’s, not yours: open one to see what it did."
        onClick={() => actions.run({ type: 'toggle_fold', key })}
      />
      {shown.map((w) => {
        const sub = agentOfWorktree(sessions, w);
        return sub ? (
          <AgentRow key={w.id} s={sub} indent={indent + 1} worktree={w} />
        ) : (
          <Row
            key={w.id}
            data-subagent={agentIdOfPath(w.path)}
            indent={indent + 1}
            selected={selected.ws === w.id}
            className={cx(s.row, s.quiet)}
            icon={<Icon name="bot" size={13} className={s.bot} />}
            label={<span className={s.label}>{`Agent ${(agentIdOfPath(w.path) ?? w.name).slice(0, 7)}`}</span>}
            detail={`A sub-agent’s worktree (${w.branch ?? w.name}): open it to see what it did`}
            onClick={() => actions.run({ type: 'open_ws', id: w.id })}
          />
        );
      })}
    </div>
  );
}

export { isAgentWorktree };