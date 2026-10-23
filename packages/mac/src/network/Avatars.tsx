import type { PresenceState } from '@beluga/net/mesh/views.js';
import { Avatar, cx, personColor } from '../components/ui.js';
import { STATE_LABEL } from './net-model.js';
import s from './network.module.css';

/**
 * A presence dot: green online, yellow away, red with a bar for Do Not Disturb, a hollow ring
 * offline. On an avatar it sits in the corner with a ring of the background around it.
 */
export function PresenceDot({ state, size = 9, label }: { state: PresenceState; size?: number; label?: string }) {
  return <span className={cx(s.dot, s[`dot_${state}`])} style={{ width: size, height: size }} role="img" aria-label={label ?? STATE_LABEL[state]} />;
}

/** Someone's avatar with their presence in the corner. */
export function PersonAvatar({ name, id, state, size = 22 }: { name: string; id: string; state?: PresenceState; size?: number }) {
  const dot = Math.min(16, Math.max(7, Math.round(size * 0.38)));
  return (
    <span className={s.avatarWrap} style={{ width: size, height: size }}>
      <Avatar name={name} id={id} size={size} />
      {state ? (
        <span className={s.avatarDot}>
          <PresenceDot state={state} size={dot} label={`${name}: ${STATE_LABEL[state]}`} />
        </span>
      ) : null}
    </span>
  );
}

/** A group's tile: its first letter on a rounded square in a color of its own (people are round). */
export function GroupAvatar({ name, id, size = 22, muted }: { name: string; id: string; size?: number; muted?: boolean }) {
  const color = personColor(`g:${id}`);
  return (
    <span
      className={cx(s.groupTile, muted && s.groupTileMuted)}
      style={{ width: size, height: size, fontSize: size * 0.46, borderRadius: Math.round(size * 0.3), background: `linear-gradient(180deg, color-mix(in srgb, ${color} 78%, white), ${color})` }}
      aria-hidden="true"
    >
      {(name.trim()[0] ?? '#').toUpperCase()}
    </span>
  );
}

/** A few members' avatars overlapping (the group's header button). */
export function AvatarStack({ people, size = 22, max = 4 }: { people: ReadonlyArray<{ peerId: string; name: string }>; size?: number; max?: number }) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <span className={s.stack} aria-hidden="true">
      {shown.map((p) => (
        <span key={p.peerId} className={s.stackItem}>
          <Avatar name={p.name} id={p.peerId} size={size} />
        </span>
      ))}
      {rest > 0 ? (
        <span className={cx(s.stackItem, s.stackMore)} style={{ width: size, height: size, fontSize: size * 0.4 }}>
          +{rest}
        </span>
      ) : null}
    </span>
  );
}
