import * as Context from '@radix-ui/react-context-menu';
import { type ReactNode, useState } from 'react';
import { TRUST_INFO, canRunOn, trustOf } from '@beluga/core/trust.js';
import { TRUST_LEVELS, type TrustLevel } from '@beluga/shared/settings-schema.js';
import { Icon } from '../../components/Icon.js';
import { cx } from '../../components/ui.js';
import { useActions } from '../../lib/actions.js';
import { useApi, useApp, useBeluga } from '../../lib/beluga.js';
import { Alert, optionIndex } from './parts.js';
import { RunCommandSheet, addressTo } from './PeerSheets.js';
import { presetShareWith } from './ShareFolderSheet.js';
import m from '../../components/SpecMenu.module.css';
import p from './person.module.css';

interface Item {
  readonly label: string;
  readonly run: () => void;
  readonly danger?: boolean;
}

/**
 * Right-click on someone in People: Trust as a submenu (the level they have is ticked), then
 * what you can do with them. The same actions as their card.
 */
export function PersonContextMenu({ index, children }: { index: number; children: ReactNode }) {
  const [removing, setRemoving] = useState<{ name: string; guest: boolean; run: () => void }>();
  const [running, setRunning] = useState(false);
  const peer = useApp((st) => st.peers[index]);
  return (
    <>
      <Context.Root modal={false}>
        <Context.Trigger asChild>{children}</Context.Trigger>
        <Context.Portal>
          <Context.Content className={m.menu} collisionPadding={8}>
            <Items index={index} onRemove={setRemoving} onRun={() => setRunning(true)} />
          </Context.Content>
        </Context.Portal>
      </Context.Root>
      {running && peer ? <RunCommandSheet peer={peer} close={() => setRunning(false)} /> : null}
      {removing ? (
        <Alert
          title={`Remove ${removing.name}?`}
          message={removing.guest ? 'They are disconnected and lose access to everything you invited them to.' : `${removing.name} is disconnected and the room’s invite link changes, so the old one stops working.`}
          confirm="Remove"
          onCancel={() => setRemoving(undefined)}
          onConfirm={() => {
            setRemoving(undefined);
            removing.run();
          }}
        />
      ) : null}
    </>
  );
}

function Items({ index, onRemove, onRun }: { index: number; onRemove: (r: { name: string; guest: boolean; run: () => void }) => void; onRun: () => void }) {
  const api = useApi();
  const actions = useActions();
  const { client, ui } = useBeluga();
  const state = useApp((st) => st);
  const peer = state.peers[index];
  if (!peer) return null;
  const menu = { kind: 'person', index } as const;
  const pick = (id: string): void => {
    const i = optionIndex(client.store.getState(), menu, id);
    if (i >= 0) actions.pick(menu, i);
  };
  const me = peer.peerId === state.selfId;
  const guest = state.guests[peer.peerId];
  const grant = state.granted[peer.peerId];
  const items: Item[] = me
    ? [
        { label: 'Ask My Claude', run: () => addressTo(ui, actions, state.view, { peerId: peer.peerId, name: peer.name, claude: true, self: true }) },
        { label: 'Share a Folder…', run: () => pick('share-folder') },
        { label: 'Settings…', run: () => ui.patch({ settings: 'general' }) },
      ]
    : [
        { label: 'Message', run: () => addressTo(ui, actions, state.view, { peerId: peer.peerId, name: peer.name, claude: false }) },
        ...(peer.agent ? [{ label: `Ask ${peer.name}’s Claude`, run: () => addressTo(ui, actions, state.view, { peerId: peer.peerId, name: peer.name, claude: true }) }] : []),
        ...(!guest && canRunOn(grant?.level) ? [{ label: `Run a Command on ${peer.name}’s Mac…`, run: onRun }] : []),
        ...(guest ? [] : [{ label: state.follow === peer.peerId ? `Stop Following ${peer.name}` : `Follow ${peer.name}`, run: () => pick(state.follow === peer.peerId ? 'unfollow' : 'follow') }]),
        ...(!guest && peer.shares[0] ? [{ label: `Browse ${peer.name}’s Files`, run: () => pick('browse') }] : []),
        ...(guest ? [] : [{ label: 'Invite to a Workspace…', run: () => pick('person-invite-ws') }]),
        ...(guest ? [] : [{ label: `Share a Folder with ${peer.name}…`, run: () => (presetShareWith(peer.peerId), pick('person-share')) }]),
      ];
  const trust = trustOf(state, peer.peerId);
  const host = state.self?.host === true;
  return (
    <>
      <Context.Item className={m.item} onSelect={() => ui.openMenu(menu)}>
        <span className={m.label}>{me ? 'Show My Card' : `Show ${peer.name}’s Card`}</span>
      </Context.Item>
      <Context.Separator className={m.separator} />
      {!me && !guest ? (
        <>
          <Context.Sub>
            <Context.SubTrigger className={cx(m.item, p.subTrigger)}>
              <span className={m.label}>Trust</span>
              <span className={p.subValue}>
                {TRUST_INFO[trust].label}
                <Icon name="chevronRight" size={9} />
              </span>
            </Context.SubTrigger>
            <Context.Portal>
              <Context.SubContent className={m.menu} sideOffset={4} collisionPadding={8}>
                <Context.RadioGroup value={trust} onValueChange={(v) => void api.people.setTrust(peer.peerId, v as TrustLevel)}>
                  {TRUST_LEVELS.map((l) => (
                    <Context.RadioItem key={l} value={l} className={cx(m.item, p.radio)}>
                      <span className={p.tick}>
                        <Context.ItemIndicator>
                          <Icon name="check" size={11} />
                        </Context.ItemIndicator>
                      </span>
                      <span className={m.label}>{TRUST_INFO[l].label}</span>
                      <span className={m.hint}>{TRUST_INFO[l].detail}</span>
                    </Context.RadioItem>
                  ))}
                </Context.RadioGroup>
              </Context.SubContent>
            </Context.Portal>
          </Context.Sub>
          <Context.Separator className={m.separator} />
        </>
      ) : null}
      {items.map((it) => (
        <Context.Item key={it.label} className={m.item} onSelect={it.run}>
          <span className={m.label}>{it.label}</span>
        </Context.Item>
      ))}
      {!me && (host || guest) ? (
        <>
          <Context.Separator className={m.separator} />
          <Context.Item className={cx(m.item, m.danger)} onSelect={() => onRemove({ name: peer.name, guest: Boolean(guest), run: () => (guest ? void api.invites.remove(peer.peerId) : pick('person-remove')) })}>
            <span className={m.label}>Remove {peer.name}…</span>
          </Context.Item>
        </>
      ) : null}
    </>
  );
}
