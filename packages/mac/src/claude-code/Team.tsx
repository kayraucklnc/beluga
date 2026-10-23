import type { CcAgent, CcMessage, CcSession } from '@beluga/core/claude-code/model.js';
import { useNow } from '../chat/Items.js';
import { Icon } from '../components/Icon.js';
import { AgentCard } from './Cards.js';
import { plural, since } from './cc-model.js';
import s from './claude-code.module.css';

/**
 * Agents of a session working as a team (named so they can be messaged, or messaging each
 * other with SendMessage): their cards under one header, and the latest messages between them
 * and the lead session, as a small timeline.
 */

/** Who sent or got a message, in words. */
export function memberLabel(session: Pick<CcSession, 'agents'>, who: string): string {
  if (who === 'lead') return 'Lead session';
  const a = session.agents.find((x) => x.id === who);
  return a ? (a.name ?? a.description) : who;
}

/** The agents of the session that are in its team (none: no team). */
export function teamMembers(session: CcSession): CcAgent[] {
  const ids = new Set(session.team?.members ?? []);
  return session.agents.filter((a) => ids.has(a.id));
}

function MessageLine({ session, message, now }: { session: CcSession; message: CcMessage; now: number }) {
  return (
    <li>
      <span className={s.timelineWho}>{memberLabel(session, message.from)}</span>
      <span className={s.timelineArrow}>→</span>
      <span className={s.timelineWho}>{memberLabel(session, message.to)}</span>
      <span className={s.timelineText} title={message.summary}>
        {message.summary}
      </span>
      <span className={s.timelineWhen}>{since(now - message.ts)} ago</span>
    </li>
  );
}

export function TeamBlock({ session, onOpen }: { session: CcSession; onOpen: (agentId: string) => void }) {
  const now = useNow(true, 15_000);
  const team = session.team;
  const members = teamMembers(session);
  if (!team || !members.length) return null;
  const working = members.filter((a) => a.status === 'running').length;
  const recent = team.messages.slice(-5);
  return (
    <section className={s.team} aria-label="Team">
      <header className={s.teamHead}>
        <Icon name="people" size={13} />
        <strong>Team</strong>
        <span>
          {plural(members.length, 'member')}
          {working ? ` · ${working} working` : ''}
          {team.messages.length ? ` · ${plural(team.messages.length, 'message')}` : ''}
        </span>
      </header>
      <div className={s.grid}>
        {members.map((a) => (
          <AgentCard key={a.id} agent={a} onOpen={() => onOpen(a.id)} />
        ))}
      </div>
      {recent.length ? (
        <ol className={s.timeline} aria-label="Messages in the team">
          {recent.map((m, i) => (
            <MessageLine key={`${m.ts}:${i}`} session={session} message={m} now={now} />
          ))}
        </ol>
      ) : null}
    </section>
  );
}
