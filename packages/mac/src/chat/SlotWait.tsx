import { SLOT_WAIT_TITLE, type SlotWait, slotWaitDetail } from '@beluga/shared/run-slots.js';
import { Icon } from '../components/Icon.js';
import { Button, Tip } from '../components/ui.js';
import { toast, useBeluga } from '../lib/beluga.js';
import s from './slot-wait.module.css';

/**
 * A message that waits only because your Claude already works in as many conversations as it may
 * at once (Settings › Claude › Working at once): says so, shows them as busy pills, and offers to
 * start it anyway or change the limit. `requestId`: yours to start now (else just the words).
 */
export function SlotWaitNotice({ wait, requestId }: { wait: SlotWait; requestId?: string }) {
  const { client, ui } = useBeluga();
  const busy = Math.max(wait.running, wait.limit);
  const startNow = (): void =>
    void client.api.host.promote(requestId ?? '').catch((err: unknown) => toast(client, err instanceof Error ? err.message : String(err), 'error'));
  return (
    <div className={s.wait} role="status">
      <span className={s.icon}>
        <Icon name="gauge" size={14} />
      </span>
      <div className={s.body}>
        <div className={s.title}>{SLOT_WAIT_TITLE}</div>
        <div className={s.detail}>{slotWaitDetail(wait)}</div>
        <Tip label={`${busy} of ${wait.limit} at once`}>
          <span className={s.pills} aria-label={`${busy} of ${wait.limit} conversations working`}>
            {Array.from({ length: Math.min(busy, 30) }, (_, i) => (
              <span key={i} className={s.pill} />
            ))}
          </span>
        </Tip>
        {requestId ? (
          <div className={s.actions}>
            <Button size="small" icon="play" onClick={startNow} title="Starts it now, past the limit">
              Start now
            </Button>
            <Button size="small" variant="quiet" icon="gear" onClick={() => ui.patch({ settings: 'claude' })} title="Settings › Claude › Working at once">
              Change the limit
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
