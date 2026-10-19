import type { PeerInfo, Usage } from '@klaud/protocol.js';
import type { AppState } from '@klaud/core/store.js';
import { Avatar } from '../../components/ui.js';
import { Card, Meter } from './parts.js';
import { ago, resetsAt } from './usage-model.js';
import s from './usage.module.css';

type Window = NonNullable<Usage['fiveHour']>;

function WindowMeter({ title, w, now }: { title: string; w: Window; now: number }) {
  return (
    <div className={s.window}>
      <div className={s.windowHead}>
        <span className={s.windowTitle}>{title}</span>
        <span className={s.windowPct}>
          {w.pct}
          <small>%</small>
        </span>
      </div>
      <Meter pct={w.pct} label={`${title}: ${w.pct}% used`} />
      <div className={s.windowFoot}>{w.resetsAt && w.resetsAt > now ? `Resets ${resetsAt(w.resetsAt, now)}` : `${100 - w.pct}% left`}</div>
    </div>
  );
}

function FriendWindow({ name, label, w }: { name: string; label: '5h' | 'wk'; w: Window | undefined }) {
  if (!w) return <span />;
  return (
    <span className={s.friendMeter}>
      <span className={s.friendLabel}>{label}</span>
      <Meter pct={w.pct} size="mini" label={`${name}: ${label === '5h' ? '5-hour' : 'week'} ${w.pct}% used`} />
      <span className={s.friendPct}>{w.pct}%</span>
    </span>
  );
}

function Friend({ peer }: { peer: PeerInfo }) {
  return (
    <li className={s.friend}>
      <span className={s.friendName}>
        <Avatar name={peer.name} id={peer.peerId} size={18} />
        {peer.name}
      </span>
      <FriendWindow name={peer.name} label="5h" w={peer.usage?.fiveHour} />
      <FriendWindow name={peer.name} label="wk" w={peer.usage?.week} />
    </li>
  );
}

/** Your Claude plan's 5-hour and weekly windows as meters; friends' (from the room) underneath. */
export function PlanCard({ state, now }: { state: AppState; now: number }) {
  const selfId = state.self?.peerId ?? state.selfId;
  const mine = state.peers.find((p) => p.peerId === selfId)?.usage ?? state.self?.usage;
  const friends = state.peers.filter((p) => p.peerId !== selfId && (p.usage?.fiveHour || p.usage?.week));
  const known = Boolean(mine?.fiveHour || mine?.week);
  return (
    <Card
      label="Claude plan"
      title="Claude plan"
      aside={
        <>
          {mine?.plan ? <span className={s.planBadge}>{mine.plan}</span> : null}
          {mine && known ? <span className={s.updated}>Updated {ago(mine.updatedAt, now)}</span> : null}
        </>
      }
    >
      {known && mine ? (
        <div className={s.windows}>
          {mine.fiveHour ? <WindowMeter title="5-hour" w={mine.fiveHour} now={now} /> : null}
          {mine.week ? <WindowMeter title="Weekly" w={mine.week} now={now} /> : null}
        </div>
      ) : (
        <p className={s.quiet}>Your plan’s limits show up here after Claude’s next run.</p>
      )}
      {friends.length ? (
        <div className={s.friends}>
          <div className={s.subhead}>Friends</div>
          <ul className={s.friendList} aria-label="Friends’ Claude usage">
            {friends.map((p) => (
              <Friend key={p.peerId} peer={p} />
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
