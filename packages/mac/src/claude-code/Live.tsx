import { useMemo } from 'react';
import { type CcSession, outsideSessions, runningAgents, sessionsIn } from '@beluga/core/claude-code/model.js';
import { useNow } from '../chat/Items.js';
import { Icon } from '../components/Icon.js';
import { Badge, Button, Dot, cx } from '../components/ui.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { Row } from '../layout/sidebar-parts.js';
import { AgentCard } from './Cards.js';
import { agentLabel, agentTone, openActivity, placeLabel, plural, sessionLabel, tokens } from './cc-model.js';
import { cappedAgents, inStartOrder } from './subagents-model.js';
import i from '../layout/Inspector.module.css';
import s from './claude-code.module.css';

/**
 * Where Claude Code's live sessions show outside Activity: a strip above a workspace's chat, a
 * panel on a worktree's info page, the Inspector, and the sidebar's Activity row.
 */

/** The Claude Code sessions in one workspace (selected without making a new array each time). */
export function useSessionsIn(workspaceId: string | undefined): CcSession[] {
  const all = useApp((st) => st.claudeCode.sessions);
  return useMemo(() => (workspaceId ? sessionsIn(outsideSessions(all), workspaceId) : []), [all, workspaceId]);
}

const MAX_PILLS = 3;

/** A slim bar above a workspace's chat: Claude Code is working here (outside Beluga), and its agents. */
export function LiveStrip({ workspaceId }: { workspaceId: string }) {
  const { client } = useBeluga();
  const sessions = useSessionsIn(workspaceId);
  const session = sessions[0];
  const now = useNow(Boolean(session && session.status === 'working'), 5000);
  if (!session) return null;
  const st = sessionLabel(session, now);
  // In the order they started, the newest few as pills: an agent finishing never moves or hides one (BLG-21).
  const agents = inStartOrder(session.agents);
  const running = agents.filter((a) => a.status === 'running').length;
  const { shown, hidden } = cappedAgents(agents, MAX_PILLS);
  return (
    <div className={s.liveStrip} role="region" aria-label="Claude Code in this folder">
      <button type="button" className={s.liveLead} onClick={() => openActivity(client, session.id)} title={`${session.title} · ${st.label}`}>
        {st.tone === 'claude' ? <Dot tone="claude" live /> : <Dot tone={st.tone === 'ok' ? 'ok' : 'muted'} />}
        <span className={s.liveName}>Claude Code</span>
        <span className={s.liveTitle}>{session.title}</span>
        <span className={cx(s.liveState, s[`tone_${st.tone}`])}>{running ? `${running} running` : st.label}</span>
      </button>
      {shown.map((a) => (
        <button key={a.id} type="button" className={s.pill} onClick={() => openActivity(client, session.id, a.id)} title={`${a.description} · ${agentLabel(a)}${a.step ? ` · ${a.step}` : ''}`}>
          <span className={s.pillMark}>{a.status === 'running' ? <Dot tone="subagent" live /> : <Icon name={a.status === 'failed' ? 'x' : 'check'} size={10} className={s[`tone_${agentTone(a)}`]} />}</span>
          <span className={s.pillText}>{a.description}</span>
        </button>
      ))}
      {hidden ? (
        // Always the same place: this session in Activity, with every one of its agents.
        <button type="button" className={cx(s.pill, s.pillMore)} onClick={() => openActivity(client, session.id)} title={`${plural(hidden, 'earlier agent')}: show all ${agents.length} in Activity`} aria-label={`Show all ${agents.length} agents in Activity`}>
          +{hidden}
        </button>
      ) : null}
      {sessions.length > 1 ? (
        <button type="button" className={cx(s.pill, s.pillMore)} onClick={() => openActivity(client)}>
          {plural(sessions.length - 1, 'more session')}
        </button>
      ) : null}
    </div>
  );
}

/** A worktree's info page: what's running in it right now, with a way to open it. */
export function LivePanel({ workspaceId }: { workspaceId: string }) {
  const { client } = useBeluga();
  const sessions = useSessionsIn(workspaceId);
  const now = useNow(sessions.some((x) => x.status === 'working'), 5000);
  if (!sessions.length) return null;
  return (
    <section className={s.livePanel} aria-label="Live in Claude Code">
      {sessions.map((x) => {
        const st = sessionLabel(x, now);
        return (
          <div key={x.id} className={s.livePanelSession}>
            <div className={s.livePanelHead}>
              {st.tone === 'claude' ? <Dot tone="claude" live /> : <Dot tone={st.tone === 'ok' ? 'ok' : 'muted'} />}
              <span className={s.livePanelTitle}>
                <span className={s.livePanelKicker}>Live in Claude Code</span>
                <span className={s.sessionTitle}>{x.title}</span>
              </span>
              <span className={cx(s.liveState, s[`tone_${st.tone}`])}>{st.label}</span>
              <Button size="small" variant="primary" icon="chevronRight" onClick={() => openActivity(client, x.id)}>
                Open
              </Button>
            </div>
            {x.step ? <div className={s.livePanelStep}>{x.step}</div> : null}
            {x.agents.length ? (
              <div className={s.grid}>
                {x.agents.map((a) => (
                  <AgentCard key={a.id} agent={a} onOpen={() => openActivity(client, x.id, a.id)} />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

function SessionDetails({ session }: { session: CcSession }) {
  const { client } = useBeluga();
  const place = useApp((st) => placeLabel(st, session));
  const now = useNow(session.status === 'working', 5000);
  const st = sessionLabel(session, now);
  return (
    <div className={s.inspectorSession}>
      <button type="button" className={s.inspectorHead} onClick={() => openActivity(client, session.id)}>
        {st.tone === 'claude' ? <Dot tone="claude" live /> : <Dot tone={st.tone === 'ok' ? 'ok' : 'muted'} />}
        <span className={s.inspectorTitle}>{session.title}</span>
        <Icon name="chevronRight" size={10} />
      </button>
      <div className={i.field}>
        <span className={i.fieldLabel}>State</span>
        <span className={cx(i.fieldValue, s[`tone_${st.tone}`])}>{st.label}</span>
      </div>
      <div className={i.field}>
        <span className={i.fieldLabel}>Folder</span>
        <span className={i.fieldValue}>{place}</span>
      </div>
      {session.model ? (
        <div className={i.field}>
          <span className={i.fieldLabel}>Model</span>
          <span className={i.fieldValue}>{session.model}</span>
        </div>
      ) : null}
      {session.tokens ? (
        <div className={i.field}>
          <span className={i.fieldLabel}>Context</span>
          <span className={cx(i.fieldValue, s.num)}>{tokens(session.tokens)} tokens</span>
        </div>
      ) : null}
      {session.agents.map((a) => (
        <button key={a.id} type="button" className={s.inspectorAgent} onClick={() => openActivity(client, session.id, a.id)} title={a.step ?? ''}>
          {a.status === 'running' ? <Dot tone="subagent" live /> : <Icon name={a.status === 'failed' ? 'x' : a.status === 'finished' ? 'check' : 'clock'} size={10} className={s[`tone_${agentTone(a)}`]} />}
          <span className={s.inspectorAgentText}>{a.description}</span>
          <span className={s.num}>{plural(a.steps, 'step')}</span>
        </button>
      ))}
    </div>
  );
}

/** The Inspector's Claude Code panel: for the workspace you're in, or the session you're watching. */
export function ClaudeCodeInspector() {
  const view = useApp((st) => st.view);
  const raw = useApp((st) => st.claudeCode.sessions);
  const sessions = useMemo(() => {
    const all = outsideSessions(raw);
    return view.kind === 'workspace' ? sessionsIn(all, view.id) : view.kind === 'claude_code' && view.session ? all.filter((x) => x.id === view.session) : [];
  }, [raw, view]);
  if (!sessions.length) return null;
  return (
    <section className={i.panel}>
      <div className={i.panelHead}>
        <h3>Claude Code</h3>
      </div>
      {sessions.map((x) => (
        <SessionDetails key={x.id} session={x} />
      ))}
    </section>
  );
}

/** The sidebar's Activity row: how many agents are running outside Beluga right now. */
/** `whenLive`: only while a session runs outside Beluga (or you're looking at Activity). */
export function ActivityRow({ whenLive }: { whenLive?: boolean } = {}) {
  const { client } = useBeluga();
  const running = useApp((st) => runningAgents(outsideSessions(st.claudeCode.sessions)));
  const live = useApp((st) => outsideSessions(st.claudeCode.sessions).length > 0);
  const selected = useApp((st) => st.view.kind === 'claude_code');
  if (whenLive && !live && !selected) return null;
  return (
    <Row
      icon={<Icon name="pulse" size={14} />}
      label="Activity"
      detail={running ? `${plural(running, 'Claude Code agent')} running outside Beluga` : 'Claude Code sessions running outside Beluga (a terminal, another app), live'}
      selected={selected}
      onClick={() => openActivity(client)}
      trailing={running ? <Badge count={running} /> : live ? <Dot tone="muted" /> : null}
    />
  );
}
