import { useMemo } from 'react';
import type { CcAgent, CcSession } from '@klaud/core/claude-code/model.js';
import { useNow } from '../chat/Items.js';
import { Icon } from '../components/Icon.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { Button, Dot, Empty, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp, useKlaud } from '../lib/klaud.js';
import { AgentCard, SessionChip } from './Cards.js';
import { chatOf } from './chat-of.js';
import { LiveTranscript } from './LiveTranscript.js';
import { TeamBlock, teamMembers } from './Team.js';
import { activitySummary, agentElapsed, agentLabel, agentTone, groupByProject, openActivity, placeLabel, plural, sessionLabel, tokens, typeLabel } from './cc-model.js';
import s from './claude-code.module.css';

/**
 * Activity: every Claude Code session running outside klaud (a terminal, another app), by project,
 * with its sub-agents as cards. A session in one of Klaud's worktrees opens that worktree's chat
 * (where it's followed and continued); one Klaud has no chat for opens as a live transcript.
 */

export const OUTSIDE = 'Running in Claude Code, outside Klaud';

/** Open where a session is followed: its worktree's chat when Klaud has one, else its transcript here. */
function useOpenSession(session: CcSession): (agentId?: string) => void {
  const { client } = useKlaud();
  const actions = useActions();
  const chat = useApp((st) => chatOf(st, session));
  return (agentId) => (chat ? actions.run({ type: 'open_ws', id: chat }) : openActivity(client, session.id, agentId));
}

function SessionRow({ session }: { session: CcSession }) {
  const open = useOpenSession(session);
  const chat = useApp((st) => chatOf(st, session));
  const place = useApp((st) => placeLabel(st, session));
  const now = useNow(session.status === 'working', 5000);
  const st = sessionLabel(session, now);
  const running = session.agents.filter((a) => a.status === 'running').length;
  const team = new Set(teamMembers(session).map((a) => a.id));
  const others = session.agents.filter((a) => !team.has(a.id));
  return (
    <section className={s.session} aria-label={`Claude Code session ${session.title}`}>
      <button type="button" className={s.sessionHead} onClick={() => open()}>
        <span className={s.sessionDot}>{st.tone === 'claude' ? <Dot tone="claude" live /> : <Dot tone={st.tone === 'ok' ? 'ok' : 'muted'} />}</span>
        <span className={s.sessionText}>
          <span className={s.sessionTitle}>{session.title}</span>
          <span className={s.sessionMeta}>
            <span className={s[`tone_${st.tone}`]}>{st.label}</span>
            <span>{place}</span>
            {session.agents.length ? <span>{running ? `${running} of ${plural(session.agents.length, 'agent')} running` : plural(session.agents.length, 'agent')}</span> : null}
          </span>
        </span>
        <span className={s.sessionOpen}>
          {chat ? 'Open Chat' : 'Watch'}
          <Icon name="chevronRight" size={10} />
        </span>
      </button>
      {/* Agents working as a team (named, messaging each other) under one header, with their messages. */}
      <TeamBlock session={session} onOpen={(id) => open(id)} />
      {others.length ? (
        <div className={s.grid}>
          {others.map((a) => (
            <AgentCard key={a.id} agent={a} onOpen={() => open(a.id)} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ActivityList() {
  const sessions = useApp((st) => st.claudeCode.sessions);
  const projects = useApp((st) => st.projects);
  // Selectors must return what's in the state (a fresh array each time would render forever).
  const groups = useMemo(() => groupByProject({ projects }, sessions), [projects, sessions]);
  if (!sessions.length) {
    return (
      <div className={s.page}>
        <Empty icon="claude" title="No Claude Code sessions right now" detail="When you run Claude Code in a terminal or another app, its sessions and their agents show here live." />
      </div>
    );
  }
  return (
    <div className={s.page}>
      <div className={s.inner}>
        <header className={s.summary}>
          <h1 className={s.summaryTitle}>{activitySummary(sessions)}</h1>
          <p className={s.summaryText}>Claude Code sessions running outside Klaud, and the agents they started. You can watch them here; they keep running where they are.</p>
        </header>
        {groups.map((g) => (
          <section key={g.key} className={s.group} aria-label={g.name}>
            <h2 className={s.groupTitle}>
              {g.projectId ? <ProjectIcon id={g.projectId} name={g.name} size={18} /> : <Icon name="folder" size={16} />}
              <span>{g.name}</span>
              <span className={s.groupCount}>{g.running ? `${g.running} running` : plural(g.sessions.length, 'session')}</span>
            </h2>
            {g.sessions.map((x) => (
              <SessionRow key={x.id} session={x} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function AgentLine({ agent }: { agent: CcAgent }) {
  const now = useNow(agent.status === 'running');
  return (
    <div className={s.focusMeta}>
      <span className={s.typeBadge}>{typeLabel(agent.type)}</span>
      <span className={cx(s.cardStatus, s[`tone_${agentTone(agent)}`])}>
        {agent.status === 'running' ? <Dot tone="claude" live /> : null}
        {agentLabel(agent)}
      </span>
      <span>{agentElapsed(agent, now)}</span>
      <span>{plural(agent.steps, 'step')}</span>
      {agent.tokens ? <span>{tokens(agent.tokens)} context</span> : null}
    </div>
  );
}

/** One session: its agents in a row (the main conversation first) and the chosen one's transcript. */
export function SessionPage({ session, agentId }: { session: CcSession; agentId?: string }) {
  const { client } = useKlaud();
  const actions = useActions();
  const chat = useApp((st) => chatOf(st, session));
  const place = useApp((st) => placeLabel(st, session));
  const now = useNow(session.status === 'working', 5000);
  const st = sessionLabel(session, now);
  const agent = agentId ? session.agents.find((a) => a.id === agentId) : undefined;
  const version = agent ? `${agent.lastAt}:${agent.steps}:${agent.status}` : `${session.lastAt}:${session.steps}:${session.status}`;
  const live = agent ? agent.status === 'running' : session.status === 'working';
  return (
    <div className={s.sessionPage}>
      <header className={s.focusHead}>
        <Button size="small" variant="quiet" icon="back" onClick={() => openActivity(client)}>
          Activity
        </Button>
        <div className={s.focusTitles}>
          <h1 className={s.focusTitle}>{agent ? agent.description : session.title}</h1>
          <div className={s.focusMeta}>
            {agent ? <span>{session.title}</span> : <span className={s[`tone_${st.tone}`]}>{st.label}</span>}
            <span>{place}</span>
            {!agent && session.model ? <span>{session.model}</span> : null}
          </div>
        </div>
        {chat ? (
          <Button size="small" icon="chat" onClick={() => actions.run({ type: 'open_ws', id: chat })}>
            Open Chat
          </Button>
        ) : (
          <span className={s.readOnly} title="It runs in a terminal or another app; Klaud shows it live">
            <Icon name="eye" size={12} />
            {OUTSIDE}
          </span>
        )}
      </header>
      {session.agents.length ? (
        <div className={s.strip} role="group" aria-label="Agents in this session">
          <SessionChip session={session} selected={!agentId} onOpen={() => openActivity(client, session.id)} />
          {session.agents.map((a) => (
            <AgentCard key={a.id} agent={a} compact selected={a.id === agentId} onOpen={() => openActivity(client, session.id, a.id)} />
          ))}
        </div>
      ) : null}
      {agent ? <AgentLine agent={agent} /> : null}
      {agentId && !agent ? (
        <Empty icon="clock" title="This agent went quiet" detail="Klaud stops watching agents a while after they finish." action={<Button onClick={() => openActivity(client, session.id)}>Show the Conversation</Button>} />
      ) : (
        <LiveTranscript key={`${session.id}/${agentId ?? ''}`} sessionId={session.id} {...(agentId ? { agentId } : {})} version={version} live={live} label={agent ? `Agent ${agent.description}` : `Claude Code session ${session.title}`} />
      )}
    </div>
  );
}

export function ActivityView() {
  const { client } = useKlaud();
  const view = useApp((st) => st.view);
  const sessionId = view.kind === 'claude_code' ? view.session : undefined;
  const agentId = view.kind === 'claude_code' ? view.agent : undefined;
  const session = useApp((st) => (sessionId ? st.claudeCode.sessions.find((x) => x.id === sessionId) : undefined));
  if (!sessionId) return <ActivityList />;
  if (!session) {
    return (
      <div className={s.page}>
        <Empty icon="clock" title="This session went quiet" detail="Klaud shows Claude Code sessions while they work, and for a while after." action={<Button onClick={() => openActivity(client)}>Show All Activity</Button>} />
      </div>
    );
  }
  return <SessionPage session={session} {...(agentId ? { agentId } : {})} />;
}
