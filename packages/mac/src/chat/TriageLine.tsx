import { categoryOf, triageKey } from '@beluga/core/triage/model.js';
import { triageFacts } from '@beluga/core/triage/facts.js';
import { Button } from '../components/ui.js';
import { settledWords, wakeWords } from '../layout/attention-model.js';
import { unsettle, wake } from '../layout/row-triage-actions.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { useClock } from '../lib/window-active.js';
import s from './TriageLine.module.css';

/**
 * One line above the message box of a Settled or Snoozed chat: why, or until when, and the way
 * back. The box itself works the same in every category: sending brings the chat back.
 */
export function TriageLine({ channel }: { channel: string }) {
  const { client } = useBeluga();
  const line = useApp((state) => {
    const key = state.prefs.chatCategories ? triageKey(state, channel) : undefined;
    if (!key) return undefined;
    const record = state.triage[key];
    const category = categoryOf(record, triageFacts(state, key));
    if (category === 'settled' && record?.settled) return { kind: 'settled', settled: record.settled, idleDays: state.prefs.settleIdleDays } as const;
    if (category === 'snoozed' && record?.snoozed) return { kind: 'snoozed', until: record.snoozed.until } as const;
    return undefined;
  }, sameDeep);
  const now = useClock(line !== undefined, 30_000);
  if (!line) return null;
  return (
    <div className={s.line} role="status" aria-label="Chat category">
      <span className={s.words}>{line.kind === 'settled' ? settledWords(line.settled, line.idleDays, now) : `Snoozed until ${wakeWords(line.until, now)}`}</span>
      {line.kind === 'settled' ? (
        <Button size="small" onClick={() => void unsettle(client, channel)}>
          Un-settle
        </Button>
      ) : (
        <Button size="small" onClick={() => void wake(client, channel)}>
          Wake
        </Button>
      )}
    </div>
  );
}
