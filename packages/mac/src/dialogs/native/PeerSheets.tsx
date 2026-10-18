import { useState } from 'react';
import { Button } from '../../components/ui.js';
import type { View } from '@klaud/core/store.js';
import type { PeerInfo } from '@klaud/protocol.js';
import type { Actions } from '../../lib/actions.js';
import { useActions } from '../../lib/actions.js';
import { type Recipient, type UiStore, toast, useApi, useApp, useKlaud } from '../../lib/klaud.js';
import { Field, Sheet } from './parts.js';
import s from './sharing.module.css';

/** A conversation is on screen (where a message, or a command's output, shows up). */
const chatShown = (v: View): boolean => v.kind === 'room' || ((v.kind === 'workspace' || v.kind === 'shared') && v.tab === 'chat');

/**
 * Start a message to someone: the composer shows "To bob" (or "To bob's Claude") as a chip, and
 * what you type goes to them. Messages to a person go to the room's chat; asking a Claude stays
 * in the conversation you're in (or the room's, when none is on screen).
 */
export function addressTo(ui: UiStore, actions: Actions, view: View, to: Recipient): void {
  if (!to.claude || !chatShown(view)) actions.run({ type: 'view', view: { kind: 'room' } });
  ui.patch({ to, menu: undefined, focus: 'chat' });
  setTimeout(() => document.dispatchEvent(new CustomEvent('klaud:focus-composer')), 30);
}

/** Run a command on a friend's computer: type it here, they approve (unless they fully trust you). */
export function RunCommandSheet({ peer, close }: { peer: PeerInfo; close: () => void }) {
  const api = useApi();
  const actions = useActions();
  const { client } = useKlaud();
  const level = useApp((st) => st.granted[peer.peerId]?.level);
  const [cmd, setCmd] = useState('');
  const run = (): void => {
    const command = cmd.trim();
    if (!command) return;
    const view = client.store.getState().view;
    const here = chatShown(view) && view.kind !== 'room' ? `ws:${(view as { id: string }).id}` : 'room';
    if (here === 'room') actions.run({ type: 'view', view: { kind: 'room' } });
    api.session.runOnPeerByHand(peer.name, command, here).catch((err: unknown) => toast(client, err instanceof Error ? err.message : String(err), 'error'));
    close();
  };
  return (
    <Sheet
      title={`Run a Command on ${peer.name}’s Mac`}
      subtitle={level === 'full' ? 'It runs right away. The output shows in the chat.' : `${peer.name} approves it first. The output shows in the chat.`}
      icon="terminal"
      close={close}
      onReturn={run}
      footer={
        <>
          <span />
          <ButtonRow onCancel={close} onOk={run} ok="Run" disabled={!cmd.trim()} />
        </>
      }
    >
      <Field label="Command" htmlFor="peer-command">
        <input id="peer-command" className={s.input} style={{ fontFamily: 'var(--font-mono)' }} value={cmd} placeholder="npm test" spellCheck={false} autoFocus onChange={(e) => setCmd(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), run())} />
        <span className={s.hint}>It runs in the folder {peer.name} shares, as {peer.name}.</span>
      </Field>
    </Sheet>
  );
}

function ButtonRow({ onCancel, onOk, ok, disabled }: { onCancel: () => void; onOk: () => void; ok: string; disabled?: boolean }) {
  return (
    <>
      <Button onClick={onCancel}>Cancel</Button>
      <Button variant="primary" disabled={disabled} onClick={onOk}>
        {ok}
      </Button>
    </>
  );
}
