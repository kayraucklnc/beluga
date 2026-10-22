import { type WaitingMessage, waitingWords } from '@klaud/core/plans/watchdog.js';
import { Tip } from '../components/ui.js';
import { toast, useApi, useKlaud } from '../lib/klaud.js';
import p from './plans.module.css';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Messages waiting for a task's Claude (the head Claude's, or yours), on its card: “1 message
 * waiting · Steer Now”. Steer Now sends the first queued one at once, the way the chat's Steer does
 * (a long command or a stuck turn is interrupted). One already in the running turn just says so.
 */
export function WaitingLine({ waiting }: { waiting: readonly WaitingMessage[] }) {
  const api = useApi();
  const { client } = useKlaud();
  if (!waiting.length) return null;
  const { text: words, steer } = waitingWords(waiting);
  return (
    <span className={p.waitingLine}>
      <Tip label={waiting.map((w) => w.prompt.replace(/\s+/g, ' ').slice(0, 160) || 'A message').join('\n')}>
        <span className={p.waitingWords}>{words}</span>
      </Tip>
      {steer ? (
        <>
          <span aria-hidden="true">·</span>
          <Tip label="Claude reads it now: a long command or a stuck turn is interrupted">
            <button
              type="button"
              className={p.steerNow}
              onClick={(e) => {
                e.stopPropagation();
                void api.host.promote(steer).catch((err: unknown) => toast(client, errorText(err), 'error'));
              }}
            >
              Steer Now
            </button>
          </Tip>
        </>
      ) : (
        <span className={p.muted}>· read at Claude’s next step</span>
      )}
    </span>
  );
}
