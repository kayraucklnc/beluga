import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { Markdown } from '../chat/Markdown.js';
import { Icon } from '../components/Icon.js';
import { Button } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApi, useApp, useBeluga, useUi } from '../lib/beluga.js';
import { useAgentNameIn } from '../lib/agent-words.js';
import s from './plan.module.css';

/** An agent's plan ("Codex's plan"), full size: read it, approve it, or say what to change. */
export function PlanSheet() {
  const { ui } = useBeluga();
  const api = useApi();
  const actions = useActions();
  const qid = useUi((u) => u.planFull);
  const q = useApp((st) => st.questions.find((x) => x.qid === qid));
  const [change, setChange] = useState('');
  const agent = useAgentNameIn(q?.channel ?? '');
  if (!qid || !q || q.question.kind !== 'plan') return null;
  const close = (): void => ui.patch({ planFull: undefined });
  return (
    <Dialog.Root open onOpenChange={(v) => (v ? undefined : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.sheet} aria-describedby={undefined}>
          <div className={s.head}>
            <Icon name="wand" size={15} className={s.claude} />
            <Dialog.Title className={s.title}>{agent}'s plan</Dialog.Title>
            <Dialog.Close className={s.close} aria-label="Close">
              <Icon name="x" size={12} />
            </Dialog.Close>
          </div>
          <div className={s.body}>
            <Markdown text={q.question.plan} />
          </div>
          <form
            className={s.foot}
            onSubmit={(e) => {
              e.preventDefault();
              if (change.trim()) {
                void api.questions.answer(q.qid, { kind: 'plan', approve: false, feedback: change.trim() });
                close();
              }
            }}
          >
            <input className={`${s.input} selectable`} value={change} onChange={(e) => setChange(e.target.value)} placeholder="Something to change? Say it here and press Return" />
            <Button variant="primary" onClick={() => (actions.run({ type: 'answer', qid: q.qid, pick: 'approve' }), close())}>
              Approve plan
            </Button>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
