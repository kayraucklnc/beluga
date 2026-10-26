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
