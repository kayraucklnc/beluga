import { type ReactNode, useRef } from 'react';
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
 * What waits for Claude in this conversation, above the box you type in: send one now
 * (interrupting the current task), pull it back to edit, drop it, or change the order.
 */
export function QueueTray({ queue, selfName, onEdit }: { queue: readonly QueuedMessage[]; selfName: string; onEdit: (text: string) => void }) {
  const { client } = useKlaud();
  const api = useApi();
  const channel = useApp((st) => channelOf(st.view));
  if (!queue.length) return null;
  const yours = queue.filter((q) => q.yours);
  const call = (p: Promise<unknown>): void => void p.catch((err: unknown) => toast(client, errorText(err), 'error'));
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
                  <Tip label="Stop the current task and send this now" keys="⌥↩">
                    <button type="button" className={s.now} onClick={() => call(api.host.promote(q.requestId))}>
                      Send now
                    </button>
                  </Tip>
                </span>
              ) : null}
            </Row>
          );
        })}
      </ol>
    </section>
  );
}
