import { useState } from 'react';
import { trustOf } from '@beluga/core/trust.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { Field, FormSheet, TextInput } from '../../components/FormSheet.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { Button, Tip } from '../../components/ui.js';
import { useActions } from '../../lib/actions.js';
import { useApi, useApp } from '../../lib/beluga.js';
import { openSheet } from '../../lib/sheets.js';
import s from './fork-to-mac.module.css';
import m from './menus.module.css';

/** The folder and branch name Beluga makes from a name (as the core's `slug` does). */
const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

function Row({ icon, title, detail }: { icon: IconName; title: string; detail: string }) {
  return (
    <li className={s.row}>
      <span className={s.icon}>
        <Icon name={icon} size={13} />
      </span>
      <span>
        <span className={s.title}>{title}</span>
        <span className={s.detail}>{detail}</span>
      </span>
    </li>
  );
}

/**
 * Fork a friend's shared worktree to this Mac (BLG-312): what comes over, what stays behind, a
 * name, then one button. Their worktree goes on as it is; yours is yours.
 */
export function ForkToMacSheet({ owner, wsId, close }: { owner: string; wsId: string; close: () => void }) {
  const api = useApi();
  const ws = useApp((st) => st.shared.find((w) => w.id === wsId && w.owner === owner));
  const ownerName = useApp((st) => st.sharedProjects.find((p) => p.owner === owner)?.ownerName ?? st.network.friends.find((f) => f.peerId === owner)?.name ?? 'Your friend');
  const full = useApp((st) => trustOf(st, owner) === 'full');
  const [name, setName] = useState(ws?.name ?? '');
  if (!ws) return null;
  return (
    <FormSheet
      title={`Fork “${ws.name}” to This Mac`}
      icon="laptop"
      intro={`A worktree of your own that starts where ${ownerName}’s is now, with your Claude. ${ownerName}’s goes on as it is.`}
      submitLabel="Fork"
      canSubmit={Boolean(slug(name))}
      onSubmit={async () => {
        await api.sharing.fork(owner, wsId, name.trim());
        close();
      }}
      onCancel={close}
      width={540}
    >
      <Field label="Comes with it">
        <ul className={s.list}>
          <Row icon="branch" title="Its commits and uncommitted changes" detail="Uncommitted work stays uncommitted, as it was" />
          <Row icon="folder" title="Its Scratch" detail="Screenshots, notes and logs Claude saved" />
          <Row icon="chat" title="The conversation" detail="Your Claude remembers it and carries on" />
        </ul>
      </Field>
      <Field label="Stays behind">
        <div className={m.note}>
          <Icon name="eyeOff" size={14} />
          <span>node_modules, build output and anything else git ignores, made again by the setup here. Never a .env file or a key.</span>
        </div>
      </Field>
      {full ? null : (
        <div className={m.note}>
          <Icon name="lock" size={14} />
          <span>{`It’s ${ownerName}’s code: the setup waits until you’ve looked it over, and your .env files aren’t copied in.`}</span>
        </div>
      )}
      <Field label="Name" htmlFor="fork-mac-name" hint={slug(name) ? <>Your branch <code>beluga/{slug(name)}</code></> : undefined}>
        <TextInput id="fork-mac-name" value={name} onChange={setName} maxLength={120} spellCheck={false} />
      </Field>
    </FormSheet>
  );
}

/**
 * In a friend's worktree you work in (shared over the network), in its header: Fork to My Mac,
 * how far a fork got (waiting for their Mac, copying), and Open My Fork once it's made.
 */
export function ForkToMacButton({ owner, wsId }: { owner: string; wsId: string }) {
  const actions = useActions();
  const ws = useApp((st) => st.shared.find((w) => w.id === wsId && w.owner === owner));
  const fork = useApp((st) => st.forks[wsId]);
  const mine = useApp((st) => (fork?.wsId ? findWorkspace(st.projects, fork.wsId) : undefined));
  const ownerName = useApp((st) => st.network.friends.find((f) => f.peerId === owner)?.name ?? 'their');
  const online = useApp((st) => Boolean(st.network.friends.find((f) => f.peerId === owner)?.online));
  if (!ws || ws.via !== 'mesh' || ws.role !== 'contribute') return null;
  if (fork?.state === 'ready' && mine && !mine.archived) {
    return (
      <Tip label={`Your fork, on ${mine.branch ?? 'its own branch'}`}>
        <Button variant="quiet" icon="laptop" onClick={() => actions.run({ type: 'view', view: { kind: 'workspace', id: mine.id, tab: 'chat' } })}>
          Open My Fork
        </Button>
      </Tip>
    );
  }
  if (fork?.state === 'asking' || fork?.state === 'copying') {
    const label = fork.state === 'copying' ? 'Copying…' : online ? 'Packing…' : `Waiting for ${ownerName}’s Mac…`;
    return (
      <Tip label={fork.state === 'copying' ? 'Its changes, Scratch and conversation are coming over' : online ? `${ownerName}’s Mac is packing it` : 'It goes as soon as their Mac is back'}>
        <Button variant="quiet" icon="laptop" disabled aria-busy="true">
          {label}
        </Button>
      </Tip>
    );
  }
  return (
    <Tip label={fork?.state === 'failed' ? `Last time: ${fork.error ?? 'it didn’t work'}. Try again` : 'Your own copy of this worktree on this Mac: its changes, Scratch and conversation'}>
      <Button variant="quiet" icon="laptop" onClick={() => openSheet({ kind: 'fork_to_mac', owner, wsId })}>
        Fork to My Mac
      </Button>
    </Tip>
  );
}
