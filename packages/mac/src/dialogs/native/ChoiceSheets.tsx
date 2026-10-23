import { useEffect, useState } from 'react';
import { modelOf } from '@beluga/ui/menus.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { Field, FormSheet, PickList, formStyles as f } from '../../components/FormSheet.js';
import { Icon } from '../../components/Icon.js';
import { useApp, useBeluga } from '../../lib/beluga.js';
import type { NativeMenuProps } from './index.js';
import { usePick } from './pick.js';

/** The model for one conversation (or for new ones): a list to pick from, the current one selected. */
export function ModelSheet({ menu, close }: NativeMenuProps<'model'>) {
  const pick = usePick(menu);
  const models = useApp((st) => st.models);
  const current = useApp((st) => (menu.channel === undefined ? st.prefs.model : modelOf(st, menu.channel))) ?? '';
  const [value, setValue] = useState(current);
  return (
    <FormSheet
      title={menu.channel === undefined ? 'Model for New Conversations' : 'Model for This Conversation'}
      icon="spark"
      intro="Each conversation can use its own model. It applies from the next message."
      submitLabel="Use This Model"
      canSubmit={value !== current}
      onSubmit={() => void pick(`model:${value}`)}
      onCancel={close}
      width={500}
    >
      <PickList label="Models" value={value} onChange={setValue} onChoose={(v) => pick(`model:${v}`)} rows={models.map((m) => ({ value: m.value, name: m.label, detail: m.description, trailing: m.value === current ? <Icon name="check" size={13} /> : undefined }))} />
    </FormSheet>
  );
}

/** First thing after joining a room: may people here use your Claude? */
export function WelcomeSheet({ menu, close }: NativeMenuProps<'welcome'>) {
  const pick = usePick(menu);
  const room = useApp((st) => st.room);
  const self = useApp((st) => st.self?.name);
  const peers = useApp((st) => st.peers);
  const others = peers.filter((p) => p.name !== self).map((p) => p.name);
  const [policy, setPolicy] = useState<'share-ask' | 'share-auto' | 'share-deny'>('share-ask');
  return (
    <FormSheet
      title={`Welcome to ${room}`}
      icon="people"
      intro={
        <>
          <p>{others.length ? `${others.join(', ')} ${others.length === 1 ? 'is' : 'are'} here.` : 'Nobody else is here yet.'}</p>
          <p>Friends can ask your Claude for help. It runs on this Mac, with your Claude subscription, only in folders you share, and you always see what they ask.</p>
        </>
      }
      submitLabel="Continue"
      onSubmit={() => void pick(policy)}
      onCancel={close}
      cancelLabel="Later"
      width={520}
    >
      <Field label="Your Claude">
        <PickList
          label="Can people in this room use your Claude?"
          value={policy}
          onChange={setPolicy}
          onChoose={(v) => pick(v)}
          rows={[
            { value: 'share-ask', name: 'Ask me each time', detail: 'Recommended: you approve every request' },
            { value: 'share-auto', name: 'Everyone can use it', detail: 'Requests run without asking' },
            { value: 'share-deny', name: 'Keep it private', detail: 'Only you can use your Claude' },
          ]}
        />
      </Field>
    </FormSheet>
  );
}

/** The inbox is the notification centre here (the bell). */
export function InboxRedirect({ close }: NativeMenuProps<'inbox'>) {
  const { ui } = useBeluga();
  useEffect(() => {
    close();
    ui.patch({ notices: true });
  }, []);
  return null;
}

/** An archived workspace: restore it (the usual thing), read it, or delete it for good. */
export function ArchivedSheet({ menu, close }: NativeMenuProps<'archived'>) {
  const pick = usePick(menu);
  const ws = useApp((st) => findWorkspace(st.projects, menu.id));
  if (!ws) return null;
  const worktree = ws.kind === 'worktree';
  return (
    <FormSheet
      title={`“${ws.name}” is archived`}
      icon="archive"
      intro={worktree ? <>Its branch <code>{ws.branch ?? ''}</code> and conversation are kept. Restoring makes the worktree again from the branch.</> : 'Its conversation is kept. Restoring shows it in the sidebar again.'}
      submitLabel="Restore"
      onSubmit={() => void pick('a-restore')}
      onCancel={close}
      width={580}
      footer={
        <>
          <button type="button" className={f.linkButton} onClick={() => pick('a-open')}>
            Read Conversation
          </button>
          <button type="button" className={f.linkButton} onClick={() => pick('a-finder')}>
            Show Project in Finder
          </button>
          <button type="button" className={f.linkDanger} onClick={() => pick('a-delete')}>
            Delete…
          </button>
        </>
      }
    />
  );
}
