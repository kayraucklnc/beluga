import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { QueuedMessage } from '@klaud/ui/compose.js';
import { channelOf } from '@klaud/core/store.js';
import { Icon, type IconName } from '../components/Icon.js';
import { Tip, cx } from '../components/ui.js';
import { toast, useApi, useApp, useKlaud } from '../lib/klaud.js';
import { useFlightLanding } from './flight.js';
import s from './queue.module.css';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function Act({ icon, label, onClick, disabled }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <Tip label={label}>
      <button type="button" className={s.act} aria-label={label} onClick={onClick} disabled={disabled}>
        <Icon name={icon} size={12} />
      </button>
    </Tip>
  );
}

/** How long a row may say "Steering…" before it shows Steer again (it normally leaves the queue at once). */
const STEERING_MS = 8_000;

/**
 * Steer: Claude reads this now. Interrupts a long command (a test run) or a turn gone quiet so it
 * does; the row says "Steering…" until the message leaves the queue for the chat. `blocked`: why
 * it can't (someone else's message), shown in its tooltip and said when clicked.
 */
function SteerButton({ steering, blocked, onSteer }: { steering: boolean; blocked?: string; onSteer: () => void }) {
  const { client } = useKlaud();
  return (
    <Tip label={blocked ?? (steering ? 'Steering: sending it to Claude now' : 'Steer: Claude reads this now (a long command is interrupted for it)')} keys={blocked ? undefined : '⌥↩'}>
      <button
        type="button"
        className={cx(s.now, (blocked || steering) && s.nowOff, steering && s.steering)}
        aria-disabled={Boolean(blocked || steering)}
        onClick={() => (blocked ? toast(client, blocked, 'warn') : steering ? undefined : onSteer())}
      >
        {steering ? 'Steering…' : 'Steer'}
      </button>
    </Tip>
  );
}

/** A queued message's row: the one you just sent flies into it from the box (see flight.ts). */
function Row({ channel, prompt, mine, className, children }: { channel: string; prompt: string; mine: boolean; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLLIElement>(null);
  useFlightLanding(ref, channel, 'queue', prompt, mine);
  return (
    <li ref={ref} className={className}>
      {children}
    </li>
  );
}

/**
 * What waits for Claude in this conversation, above the box you type in: steer with one now
 * (Claude reads it now), pull it back to edit, drop it, or change the order.
 */
export function QueueTray({ queue, selfName, onEdit }: { queue: readonly QueuedMessage[]; selfName: string; onEdit: (text: string) => void }) {
  const { client } = useKlaud();
  const api = useApi();
  const channel = useApp((st) => channelOf(st.view));
  const [steering, setSteering] = useState<ReadonlySet<string>>(new Set());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  if (!queue.length) return null;
  const yours = queue.filter((q) => q.yours);
  const call = (p: Promise<unknown>): void => void p.catch((err: unknown) => toast(client, errorText(err), 'error'));
  const settle = (id: string): void =>
    setSteering((cur) => {
      const next = new Set(cur);
      next.delete(id);
      return next;
    });
  // "Steering…" until it leaves the queue; refused (the core says why in a toast) or failed: Steer again.
  const steer = (id: string): void => {
    setSteering((cur) => new Set(cur).add(id));
    api.host.promote(id).then(
      (ok) => {
        if (!ok) return settle(id);
        const t = setTimeout(() => (timers.current.delete(t), settle(id)), STEERING_MS);
        timers.current.add(t);
      },
      (err: unknown) => {
        settle(id);
        toast(client, `Couldn’t steer: ${errorText(err)}`, 'error');
      },
    );
  };
  return (
    <section className={s.tray} aria-label="Queued messages">
      <header className={s.head}>
        <Icon name="clock" size={12} />
        <span className={s.title}>Queued</span>
        <span className={s.count}>{queue.length}</span>
        <span className={s.note}>runs after the current task, in this order</span>
      </header>
      <ol className={s.list}>
        {queue.map((q, i) => {
          const at = yours.indexOf(q);
          const who = q.by === selfName ? (q.claude === selfName ? '' : `for ${q.claude}'s Claude`) : `${q.by}`;
          return (
            <Row key={q.requestId} channel={channel} prompt={q.prompt} mine={q.yours} className={cx(s.row, !q.yours && s.theirs)}>
              <span className={s.n}>{i + 1}</span>
              <span className={s.text} title={q.prompt}>
                {q.prompt || 'A message'}
              </span>
              {who ? <span className={s.who}>{who}</span> : null}
              {q.yours ? (
                <span className={s.acts}>
                  {yours.length > 1 ? (
                    <>
                      <Act icon="chevronUp" label="Move up" disabled={at === 0} onClick={() => call(api.host.reorderQueued(q.requestId, at - 1))} />
                      <Act icon="chevronDown" label="Move down" disabled={at === yours.length - 1} onClick={() => call(api.host.reorderQueued(q.requestId, at + 1))} />
                    </>
                  ) : null}
                  <Act
                    icon="pencil"
                    label="Edit: take it out of the queue and back into the box"
                    onClick={() =>
                      call(
                        api.host.cancelQueued(q.requestId).then((ok) => {
                          if (ok) onEdit(q.prompt);
                        }),
                      )
                    }
                  />
                  <Act icon="x" label="Remove from the queue" onClick={() => call(api.host.cancelQueued(q.requestId))} />
                  <SteerButton steering={steering.has(q.requestId)} onSteer={() => steer(q.requestId)} />
                </span>
              ) : (
                <span className={s.acts}>
                  <SteerButton steering={false} blocked={q.by === selfName ? `It waits for ${q.claude}'s Claude: only ${q.claude} can steer it` : `${q.by}'s message: only ${q.by} can steer it`} onSteer={() => undefined} />
                </span>
              )}
            </Row>
          );
        })}
      </ol>
    </section>
  );
}
