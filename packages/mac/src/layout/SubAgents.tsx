import { useMemo } from 'react';
import type { AgentOrigin, CcSession } from '@beluga/core/claude-code/model.js';
import type { Project, Workspace } from '@beluga/workspaces/types.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { Icon } from '../components/Icon.js';
import { type ActionItem, ActionsContext } from '../components/SpecMenu.js';
import { Dot, cx } from '../components/ui.js';
import { type Actions, useActions } from '../lib/actions.js';
import { toast, useApi, useApp, useBeluga, useUi } from '../lib/beluga.js';
import { showUndo } from '../lib/undo-toast.js';
import { agentElapsed, agentLabel, openActivity, typeLabel } from '../claude-code/cc-model.js';
import { type Residue, type SubAgent, agentResidue, agentTitle, cappedAgents, isAgentWorktree, modelLabel, subAgentsSummary, subAgentsUnder } from '../claude-code/subagents-model.js';
import { setPrefs, usePrefs } from '../lib/prefs.js';
import { useNow } from '../chat/Items.js';
import { agoText } from '../views/project/home-model.js';
import { Row } from './sidebar-parts.js';
import s from './subagents.module.css';

/**
 * Sub-agents in the sidebar: Claude's helpers, not your work. They sit under the conversation
 * that started them (a small robot, quieter than a worktree), in the order they started (newest
 * last: a row never moves when its agent finishes); the newest few show, earlier ones behind
 * "N earlier", and the whole group folds away under one "4 sub-agents · 1 running" row
 * (remembered per conversation). Their own worktrees aren't listed as worktrees: they open as the
 * agent. A sub-agent shows only under what started it, and only while Beluga follows it: old
 * agent worktrees with nothing to tie them to aren't listed (the Worktrees page has them). A
 * project's main folder has no row of its own: its sub-agents gather behind one "Agents" row.
 */

/** How many of a conversation's sub-agents show before "N more". */
const SHOWN = 3;

/** The watched sessions, as the state has them (one array: no new one each render). */
export const useCcSessions = (): readonly CcSession[] => useApp((st) => st.claudeCode.sessions);

/** Who started each sub-agent worktree still on disk (from Claude Code's files). */
export const useAgentOrigins = (): readonly AgentOrigin[] => useApp((st) => st.claudeCode.origins);

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
  // One width running or done: the row's name doesn't shift when its agent finishes.
  return <span className={s.markBox}>{status === 'running' ? <Dot tone="subagent" live /> : <Icon name={status === 'failed' ? 'x' : status === 'finished' ? 'check' : status === 'idle' ? 'clock' : 'stop'} size={10} className={cx(s.mark, status === 'failed' && s.markFailed)} />}</span>;
}

function AgentRow({ s: sub, indent, worktree, residue, menu }: { s: SubAgent; indent: number; worktree?: Workspace; residue?: Residue; menu?: readonly ActionItem[] }) {
  const { client } = useBeluga();
  const actions = useActions();
  const selected = useSelectedAgent();
  const now = useNow(sub.agent.status === 'running');
  const a = sub.agent;
  const on = selected.agent === a.id || (worktree !== undefined && selected.ws === worktree.id);
  // Finished a while ago: when, and who started it (Beluga no longer follows it live).
  const facts = sub.past ? [typeLabel(a.type), `Finished ${agoText(a.lastAt, now)}`, `started by “${sub.session.title}”`].join(' · ') : [typeLabel(a.type), modelLabel(a.model), agentLabel(a), agentElapsed(a, now)].filter(Boolean).join(' · ');
  // Done: what it left behind, plainly (running: how it's doing).
  const left = residue && a.status !== 'running' && residue.short ? residue : undefined;
  const row = (
    <Row
      data-subagent={a.id}
      indent={indent}
      selected={on}
      className={cx(s.row, a.status !== 'running' && s.quiet)}
      icon={<Icon name="bot" size={13} className={s.bot} />}
      aria-label={`Sub-agent ${agentTitle(a)}, ${agentLabel(a)}${left ? `, ${left.short}` : ''}`}
      label={<span className={s.label}>{agentTitle(a)}</span>}
      detail={`Sub-agent: ${agentTitle(a)} · ${facts}${a.worktree ? ' · in its own worktree' : ''}${left ? `\n${left.long}` : ''}`}
      onClick={() => openSubAgent(client, actions, sub)}
      trailing={left ? <span className={cx(s.left, left.kind === 'some' && s.leftSome)}>{left.short}</span> : <AgentMark status={a.status} />}
    />
  );
  return menu ? <ActionsContext items={menu}>{row}</ActionsContext> : row;
}

/** Under a conversation's row: the sub-agents it started. */
export function SubAgentRows({ ws, indent }: { ws: Workspace; indent: number }) {
  const actions = useActions();
  const sessions = useCcSessions();
  const origins = useAgentOrigins();
  const projects = useApp((st) => st.projects);
  const key = `subagents-more:${ws.id}`;
  const expanded = useUi((u) => u.collapsed.includes(key));
  // The whole group folded away (kept across launches, per conversation).
  const prefs = usePrefs();
  const foldKey = `subagents:${ws.id}`;
  const list = useMemo(() => subAgentsUnder(sessions, ws.id, origins), [sessions, ws.id, origins]);
  const selected = useSelectedAgent();
  if (!list.length) return null;
  // One sub-agent needs no group row of its own.
  const grouped = list.length > 1;
  const folded = grouped && prefs.folded.includes(foldKey);
  const worktreeOf = (sub: SubAgent): Workspace | undefined => (sub.agent.worktree ? projects.flatMap((p) => p.workspaces).find((w) => w.path === sub.agent.worktree!.path) : undefined);
  // The one you're looking at always shows when the list is capped; folding hides them all.
  const isOn = (sub: SubAgent): boolean => selected.agent === sub.agent.id || (selected.ws !== undefined && worktreeOf(sub)?.id === selected.ws);
  // The newest few, in start order: an agent finishing never moves or hides a row (BLG-21).
  const { shown, hidden } = folded ? { shown: [], hidden: 0 } : expanded ? { shown: list, hidden: 0 } : cappedAgents(list, SHOWN, isOn);
  const running = list.filter((sub) => sub.agent.status === 'running').length;
  const summary = subAgentsSummary(list);
  return (
    <div role="group" aria-label={`Sub-agents of ${ws.name}`}>
      {grouped ? (
        <Row
          indent={indent}
          className={cx(s.row, s.group)}
          aria-expanded={!folded}
          aria-label={`${summary} of ${ws.name}`}
          icon={<Icon name="chevronRight" size={9} className={cx(s.disclosure, !folded && s.disclosureOpen)} />}
          label={<span className={s.label}>{summary}</span>}
          detail={folded ? `Show the sub-agents ${ws.name} started` : `Fold away the sub-agents ${ws.name} started`}
          onClick={() => setPrefs({ folded: folded ? prefs.folded.filter((f) => f !== foldKey) : [...prefs.folded, foldKey] })}
          trailing={folded && running ? <Dot tone="subagent" live /> : null}
        />
      ) : null}
      {/* The tucked-away ones are the earlier ones: the toggle sits above the rows, where they unfold. */}
      {!folded && (hidden > 0 || expanded) ? (
        <Row
          indent={indent}
          className={cx(s.row, s.more)}
          icon={<span className={s.moreDot} />}
          label={expanded && hidden === 0 ? 'Show Fewer' : `${hidden} earlier sub-agent${hidden === 1 ? '' : 's'}`}
          onClick={() => actions.run({ type: 'toggle_fold', key })}
        />
      ) : null}
      {shown.map((sub) => {
        const wt = worktreeOf(sub);
        return <AgentRow key={`${sub.session.id}:${sub.agent.id}`} s={sub} indent={indent} {...(wt ? { worktree: wt } : {})} />;
      })}
    </div>
  );
}

/** The key that hides a done sub-agent you cleared (it had nothing of its own to lose). */
const clearedKey = (sub: SubAgent): string => `cleared-agent:${sub.session.id}:${sub.agent.id}`;

/**
 * A project's loose sub-agents: the ones a conversation in its main folder started (Claude Code
 * there, or Beluga's own questions), which belong to none of your worktrees or chats. One quiet
 * "Agents" row holds them (it unfolds in place); each says what it left behind, and the done
 * ones that left nothing clear in one go: hidden when they never had a worktree, their worktree
 * removed when it has no commits or changes (its branch is kept). Anything with work in it stays.
 */
export function ProjectAgents({ p, ws, indent }: { p: Project; ws: Workspace; indent: number }) {
  const api = useApi();
  const { client, ui } = useBeluga();
  const actions = useActions();
  const sessions = useCcSessions();
  const origins = useAgentOrigins();
  const projects = useApp((st) => st.projects);
  const collapsed = useUi((u) => u.collapsed);
  const key = `agents:${p.id}`;
  const open = collapsed.includes(key);
  const selected = useSelectedAgent();
  const all = useMemo(() => subAgentsUnder(sessions, ws.id, origins), [sessions, ws.id, origins]);
  const list = all.filter((sub) => !collapsed.includes(clearedKey(sub)));
  if (!list.length) return null;
  const worktreeOf = (sub: SubAgent): Workspace | undefined => (sub.agent.worktree ? projects.flatMap((x) => x.workspaces).find((w) => w.path === sub.agent.worktree!.path && !w.archived) : undefined);
  const rows = list.map((sub) => {
    const wt = worktreeOf(sub);
    return { sub, wt, residue: agentResidue(sub, wt) };
  });
  const running = rows.filter((r) => r.sub.agent.status === 'running').length;
  const clearable = rows.filter((r) => r.residue.clearable);
  const withWork = rows.filter((r) => r.residue.kind === 'some').length;
  const isOn = (r: (typeof rows)[number]): boolean => selected.agent === r.sub.agent.id || (selected.ws !== undefined && r.wt?.id === selected.ws);
  // Folded, the one you're looking at still shows.
  const shown = open ? rows : rows.filter(isOn);

  const clear = (list: typeof rows): void => {
    const hide = list.filter((r) => !r.wt).map((r) => clearedKey(r.sub));
    if (hide.length) {
      ui.patch({ collapsed: [...ui.get().collapsed, ...hide] });
      showUndo(`Cleared ${hide.length === 1 ? 'a sub-agent' : `${hide.length} sub-agents`}`, () => ui.patch({ collapsed: ui.get().collapsed.filter((k) => !hide.includes(k)) }));
    }
    // A worktree with nothing in it: removed (git refuses if anything changed meanwhile; its branch stays).
    for (const r of list) if (r.wt) void api.workspaces.removeOther(r.wt.id, false).catch((err: unknown) => toast(client, `${agentTitle(r.sub.agent)}: ${err instanceof Error ? err.message : String(err)}`, 'error'));
  };
  const menuOf = (r: (typeof rows)[number]): ActionItem[] => [
    { label: 'Open', icon: 'forward', onSelect: () => openSubAgent(client, actions, r.sub) },
    // What it left is archived (kept) or cleaned up where every worktree is: the Worktrees page.
    ...(r.wt ? [{ label: r.residue.kind === 'some' ? 'Archive or Clean Up in Worktrees…' : 'Show in Worktrees', icon: 'branch' as const, onSelect: () => actions.run({ type: 'view', view: { kind: 'worktrees', projectId: p.id } }) }] : []),
    ...(r.residue.clearable ? [{ label: 'Clear', icon: 'x' as const, separate: true, hint: r.wt ? 'Removes its empty worktree; the branch stays' : 'Nothing of its own to lose', onSelect: () => clear([r]) }] : []),
  ];
  const tip = [`${list.length} sub-agent${list.length === 1 ? '' : 's'} started from ${p.name}’s main folder`, running ? `${running} working` : '', withWork ? `${withWork} left work behind` : '', clearable.length ? `${clearable.length} can be cleared` : ''].filter(Boolean).join(' · ');
  return (
    <div role="group" aria-label={`Sub-agents in ${p.name}`}>
      <Row
        indent={indent}
        className={cx(s.row, s.group)}
        aria-expanded={open}
        icon={<Icon name="bot" size={13} className={s.bot} />}
        label={
          <span className={s.label}>
            Agents <span className={s.count}>· {list.length}</span>
          </span>
        }
        detail={tip}
        onClick={() => actions.run({ type: 'toggle_fold', key })}
        trailing={running ? <Dot tone="subagent" live /> : <Icon name="chevronRight" size={9} className={cx(s.disclosure, open && s.disclosureOpen)} />}
      />
      {shown.map((r) => (
        <AgentRow key={`${r.sub.session.id}:${r.sub.agent.id}`} s={r.sub} indent={indent + 1} residue={r.residue} menu={menuOf(r)} {...(r.wt ? { worktree: r.wt } : {})} />
      ))}
      {open && clearable.length ? (
        <Row
          indent={indent + 1}
          className={cx(s.row, s.more)}
          icon={<Icon name="check" size={11} />}
          label={`Clear ${clearable.length} done that left nothing`}
          detail="Only agents with nothing to lose: no commits, no uncommitted files. Their branches stay. Anything with work in it is kept."
          onClick={() => clear(clearable)}
        />
      ) : null}
    </div>
  );
}

export { isAgentWorktree };