import { useEffect, useState } from 'react';
import { shownChannel } from '@klaud/core/store.js';
import { Icon } from '../components/Icon.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { Avatar } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp, useKlaud } from '../lib/klaud.js';
import { usePrefs } from '../lib/prefs.js';
import { openDm, openGroup } from '../network/use-net.js';
import { IDLE_SIGNAL, type UnreadEntry, unreadEntries, workspaceSignal } from './attention-model.js';
import { SignalMark, nameClass, signalClass } from './signal-marks.js';
import { Row, Section } from './sidebar-parts.js';
import m from './signal.module.css';

/**
 * The top of the sidebar, like Slack's Unreads: every conversation that finished, got a
 * message, or needs you, one click away. Nothing waiting: it isn't there at all. The one you
 * open from here stays (plain, selected) while you're in it, so the list doesn't jump under you.
 */

function EntryIcon({ e }: { e: UnreadEntry }) {
  switch (e.kind) {
    case 'workspace':
      return e.project ? <ProjectIcon id={e.project.id} name={e.project.name} size={16} /> : <Icon name="chat" size={14} />;
    case 'shared':
      return <Avatar name={e.name} id={e.owner} size={16} />;
    case 'dm':
      return <Avatar name={e.name} id={e.peerId} size={16} />;
    case 'group':
      return <Icon name="people" size={14} />;
  }
}

/** Where it lives, after its name: the project, "Chats", or whose it is. */
function whereOf(e: UnreadEntry, ownerName: (id: string) => string): string {
  switch (e.kind) {
    case 'workspace':
      return e.project?.name ?? 'Chats';
    case 'shared':
      return ownerName(e.owner);
    case 'dm':
      return 'Message';
    case 'group':
      return 'Group';
  }
}

export function UnreadSection() {
  const actions = useActions();
  const { client } = useKlaud();
  const prefs = usePrefs();
  const state = useApp((st) => st);
  const here = shownChannel(state.view);
  // The one you opened from here, and whether you've got there yet (opening it takes a moment).
  const [kept, setKept] = useState<{ entry: UnreadEntry; at: number; arrived: boolean } | undefined>();
  // Leaving it lets it go.
  useEffect(() => {
    if (!kept) return;
    if (here === kept.entry.channel) {
      if (!kept.arrived) setKept({ ...kept, arrived: true });
    } else if (kept.arrived) setKept(undefined);
  }, [here, kept]);
  if (!prefs.unreadSection) return null;
  const entries = unreadEntries(state);
  const stay = kept && kept.entry.channel === here && !entries.some((e) => e.channel === here) ? kept.entry : undefined;
  // In the place it had, so nothing moves under the pointer.
  const list = stay && kept ? [...entries.slice(0, kept.at), { ...stay, signal: stay.kind === 'workspace' ? workspaceSignal(state, stay.ws) : IDLE_SIGNAL }, ...entries.slice(kept.at)] : entries;
  if (!list.length) return null;
  const ownerName = (id: string): string => state.peers.find((p) => p.peerId === id)?.name ?? 'Shared';
  const open = (e: UnreadEntry, at: number): void => {
    setKept({ entry: e, at, arrived: e.channel === here });
    if (e.kind === 'workspace') actions.run({ type: 'open_ws', id: e.ws.id });
    else if (e.kind === 'shared') actions.run({ type: 'open_shared', owner: e.owner, id: e.id, tab: 'chat' });
    else if (e.kind === 'dm') openDm(client, e.peerId);
    else openGroup(client, e.groupId);
  };
  return (
    <div role="region" aria-label="Unread" className={m.section}>
      <Section id="unread" title="Unread">
        {list.map((e, at) => {
          const selected = e.channel === here;
          const where = whereOf(e, ownerName);
          return (
            <Row
              key={e.channel}
              selected={selected}
              className={signalClass(e.signal, selected)}
              data-signal-row={e.signal.level}
              // With what's waiting, so it reads (and is found) apart from the same conversation further down.
              aria-label={`${e.name} · ${e.signal.tip || 'read'}`}
              icon={
                <span className={m.unreadIcon}>
                  <EntryIcon e={e} />
                </span>
              }
              label={
                <>
                  <span className={nameClass(e.signal)}>{e.name}</span>
                  {/* Drawn from the attribute: a hint for the eye, not more text to find (the tooltip says it). */}
                  <span className={m.where} data-where={where} aria-hidden="true" />
                </>
              }
              detail={`${where} › ${e.name}${e.signal.tip ? `: ${e.signal.tip}` : ''}`}
              onClick={() => open(e, at)}
              trailing={<SignalMark signal={e.signal} />}
            />
          );
        })}
      </Section>
    </div>
  );
}
