import { peopleHere } from '@beluga/core/friend-share-people.js';
import { Avatar, Tip, cx } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import s from './people-here.module.css';

/** The people in a worktree shared over the network, in its header: each avatar with how they're doing. */
export function PeopleHere({ wsId }: { wsId: string }) {
  const people = useApp((st) => peopleHere(st, wsId), sameDeep);
  if (!people.length) return null;
  return (
    <span className={s.people} role="list" aria-label="People in this worktree">
      {people.map((p) => (
        <Tip key={p.peerId} label={`${p.name}${p.owner ? ' (its owner)' : p.role === 'view' ? ' (follows along)' : ''}: ${p.label}`}>
          <span role="listitem" className={s.person} aria-label={`${p.name}, ${p.label}`} data-presence={p.state}>
            <Avatar name={p.name} id={p.peerId} size={20} />
            <span className={cx(s.dot, s[p.state])} aria-hidden="true" />
          </span>
        </Tip>
      ))}
    </span>
  );
}

const names = (list: readonly { name: string }[]): string => (list.length <= 2 ? list.map((p) => p.name).join(' and ') : `${list[0]!.name} and ${list.length - 1} others`);

/**
 * Above your own worktree's chat while it's shared with friends (BLG-259): who sees it, and who's
 * watching it live right now, so you know your conversation isn't only yours.
 */
export function SharedStrip({ wsId }: { wsId: string }) {
  const people = useApp((st) => peopleHere(st, wsId), sameDeep);
  if (!people.length) return null;
  const live = people.filter((p) => p.state === 'online' || p.state === 'away');
  const detail = live.length === people.length ? (people.length === 1 ? 'sees this live' : 'see this live') : live.length ? `${names(live)} ${live.length === 1 ? 'is' : 'are'} here now` : 'not here right now';
  return (
    <div className={s.strip} role="status" aria-label="Shared with friends">
      <span className={s.stripPeople}>
        {people.slice(0, 4).map((p) => (
          <span key={p.peerId} className={s.person} data-presence={p.state}>
            <Avatar name={p.name} id={p.peerId} size={16} />
            <span className={cx(s.dot, s[p.state])} aria-hidden="true" />
          </span>
        ))}
      </span>
      <span className={s.stripText}>
        Shared with {names(people)}
        <span className={s.stripDetail}> · {detail}</span>
      </span>
    </div>
  );
}
