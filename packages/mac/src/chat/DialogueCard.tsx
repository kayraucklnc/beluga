import { memo, useState } from 'react';
import type { LogItem } from '@beluga/core/store.js';
import { type DialogueAction, dialogueHeader } from '@beluga/core/dialogues/view.js';
import { Icon } from '../components/Icon.js';
import { Button, cx } from '../components/ui.js';
import { toast, useApi, useApp, useBeluga } from '../lib/beluga.js';
import s from './dialogue.module.css';

export type DialogueItem = Extract<LogItem, { type: 'system' }> & { readonly dialogue: { readonly id: string } };

export const isDialogueItem = (l: LogItem): l is DialogueItem => l.type === 'system' && Boolean((l as { dialogue?: unknown }).dialogue);

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Where a dialogue between agents begins in the chat (BLG-466): its topic, who talks, turn n of the
 * cap and the budget left, and its one main action (Start, Continue, Stop). A proposal lets you set
 * the caps before it starts. The turns follow as chat messages, each with its agent's badge.
 */
export const DialogueCard = memo(function DialogueCard({ item }: { item: DialogueItem }) {
  const api = useApi();
  const { client } = useBeluga();
  const dialogue = useApp((st) => st.dialogues[item.dialogue.id]);
  const [turns, setTurns] = useState<string>('');
  const [budget, setBudget] = useState<string>('');
  if (!dialogue) return null;
  const h = dialogueHeader(dialogue);
  const proposed = dialogue.status === 'proposed';
  const run = (action: DialogueAction): void => {
    const id = dialogue.id;
    const call =
      action === 'start'
        ? api.dialogues.confirm(id, { ...(Number(turns) > 0 ? { turnCap: Math.floor(Number(turns)) } : {}), ...(budget.trim() === '' ? {} : Number(budget) > 0 ? { budget: Math.round(Number(budget) * 1000) } : { budget: null }) })
        : action === 'continue'
          ? api.dialogues.continue(id)
          : api.dialogues.stop(id);
    call.catch((err: unknown) => toast(client, errorText(err), 'error'));
  };
  return (
    <div className={cx(s.card, s[h.tone])} data-dialogue={dialogue.id} data-dialogue-status={dialogue.status} role="group" aria-label={`Dialogue: ${h.topic}`}>
      <div className={s.head}>
        <Icon name="people" size={14} />
        <span className={s.mode}>{h.mode}</span>
        <span className={s.who}>{h.who}</span>
      </div>
      <div className={s.topic}>{h.topic}</div>
      <div className={s.meta}>
        <span>{h.progress}</span>
        {h.budget ? <span>{h.budget}</span> : null}
        <span className={s.status}>{h.status}</span>
      </div>
      {proposed ? (
        <div className={s.caps}>
          {dialogue.mode === 'cross-reference' ? null : (
            <label>
              Turns
              <input type="number" min={1} max={200} placeholder={String(dialogue.turnCap)} value={turns} onChange={(e) => setTurns(e.target.value)} />
            </label>
          )}
          <label>
            Budget (k tokens)
            <input type="number" min={1} placeholder={dialogue.budget ? String(Math.round(dialogue.budget / 1000)) : 'none'} value={budget} onChange={(e) => setBudget(e.target.value)} />
          </label>
        </div>
      ) : null}
      {h.actions.length ? (
        <div className={s.actions}>
          {h.actions.map((a, i) => (
            <Button key={a} size="small" variant={i === 0 && a !== 'stop' ? 'primary' : 'quiet'} icon={a === 'stop' || a === 'cancel' ? 'stop' : 'play'} onClick={() => run(a)} data-dialogue-action={a}>
              {a === 'start' ? 'Start' : a === 'cancel' ? 'Cancel' : a === 'continue' ? 'Continue' : 'Stop'}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
});
