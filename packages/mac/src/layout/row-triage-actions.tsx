import { useEffect, useState } from 'react';
import { type AppState } from '@beluga/core/store.js';
import { triageFacts } from '@beluga/core/triage/facts.js';
import { type ChatCategory, categoryOf, settleRefusal, triageKey } from '@beluga/core/triage/model.js';
import { snoozePresets } from '@beluga/shared/snooze-presets.js';
import { Sheet } from '../dialogs/native/parts.js';
import { ActionsDropdown, type ActionItem } from '../components/SpecMenu.js';
import { Button, IconButton } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { toast, useBeluga } from '../lib/beluga.js';
import { type CategoryEntry, conversationEntries, nextActive, wakeWords } from './attention-model.js';
import { hereOf, openEntry } from './EntryRow.js';
import s from './Sidebar.module.css';

/**
 * Changing a chat's category: the buttons on its row, the same in its right-click menu, and the
 * sheet for a snooze at a time you pick. Only while `chatCategories` is on.
 */

type Run = ReturnType<typeof useActions>['run'];
type Client = ReturnType<typeof useBeluga>['client'];

const CUSTOM_SNOOZE = 'beluga:snooze-custom';

/** The right-click items of a chat, by channel: none for what has no category, or with the setting off. */
export function triageItems(state: AppState, channel: string, run: Run, client: Client): ActionItem[] {
  const key = state.prefs.chatCategories ? triageKey(state, channel) : undefined;
  if (!key) return [];
  const record = state.triage[key];
  const facts = triageFacts(state, key);
  const category = categoryOf(record, facts);
  const refusal = settleRefusal(record, facts, 'you');
  const auto = record?.autoSettle !== false;
  return [
    { label: 'Work Again', icon: 'chat', separate: true, onSelect: () => workAgain(client, run, channel) },
    ...(category === 'snoozed' ? [{ label: 'Wake', icon: 'bell' as const, onSelect: () => wake(client, channel) }] : [{ label: 'Snooze', icon: 'clock' as const, submenu: snoozeItems(client, run, channel), onSelect: () => undefined }]),
    ...(category === 'settled'
      ? [{ label: 'Un-settle', icon: 'inbox' as const, onSelect: () => unsettle(client, channel) }]
      : [{ label: 'Settle', icon: 'check' as const, ...(refusal ? { disabled: true, hint: refusal } : {}), onSelect: () => settle(client, run, channel) }]),
    { label: `Auto-settle: ${auto ? 'on' : 'off'}`, onSelect: () => call(client, () => client.api.triage.setAutoSettle(channel, !auto)) },
  ];
}

export function RowTriageTools({ e }: { e: CategoryEntry }) {
  const actions = useActions();
  const { client } = useBeluga();
  return (
    <span className={s.hoverTools}>
      {toolsOf(e.category).includes('snooze') ? (
        <ActionsDropdown items={snoozeItems(client, actions.run, e.channel)}>
          <IconButton icon="clock" label={`Snooze ${e.name}`} onClick={(ev) => ev.stopPropagation()} />
        </ActionsDropdown>
      ) : null}
      {toolsOf(e.category).includes('settle') ? <IconButton icon="check" label={`Settle ${e.name}`} onClick={(ev) => (ev.stopPropagation(), settle(client, actions.run, e.channel))} /> : null}
      {toolsOf(e.category).includes('wake') ? <IconButton icon="bell" label={`Wake ${e.name}`} onClick={(ev) => (ev.stopPropagation(), wake(client, e.channel))} /> : null}
      {toolsOf(e.category).includes('unsettle') ? <IconButton icon="inbox" label={`Un-settle ${e.name}`} onClick={(ev) => (ev.stopPropagation(), unsettle(client, e.channel))} /> : null}
    </span>
  );
}

/** Custom…: a date and a time, from any menu that offers it. */
export function SnoozeCustomSheet() {
  const actions = useActions();
  const { client } = useBeluga();
  const [channel, setChannel] = useState<string>();
  const [value, setValue] = useState('');
  useEffect(() => {
    const show = (e: Event): void => {
      setValue('');
      setChannel((e as CustomEvent<string>).detail);
    };
    document.addEventListener(CUSTOM_SNOOZE, show);
    return () => document.removeEventListener(CUSTOM_SNOOZE, show);
  }, []);
  if (!channel) return null;
  const until = value ? new Date(value).getTime() : 0;
  const ok = until > Date.now();
  const confirm = (): void => {
    if (!ok) return;
    snooze(client, actions.run, channel, until);
    setChannel(undefined);
  };
  return (
    <Sheet
      title="Snooze until"
      icon="clock"
      close={() => setChannel(undefined)}
      onReturn={confirm}
      footer={
        <>
          <Button onClick={() => setChannel(undefined)}>Cancel</Button>
          <Button variant="primary" disabled={!ok} onClick={confirm}>
            Snooze
          </Button>
        </>
      }
    >
      <input type="datetime-local" aria-label="Date and time" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
    </Sheet>
  );
}

function toolsOf(category: ChatCategory): readonly ('snooze' | 'settle' | 'wake' | 'unsettle')[] {
  switch (category) {
    case 'active':
      return ['snooze', 'settle'];
    case 'working':
      return ['snooze'];
    case 'snoozed':
      return ['wake'];
    case 'settled':
      return ['unsettle'];
  }
}

function snoozeItems(client: Client, run: Run, channel: string): ActionItem[] {
  const now = Date.now();
  return [
    ...snoozePresets(now).map((p) => ({ label: p.label, keys: wakeWords(p.at, now), onSelect: () => snooze(client, run, channel, p.at) })),
    { label: 'Custom…', separate: true, onSelect: () => document.dispatchEvent(new CustomEvent(CUSTOM_SNOOZE, { detail: channel })) },
  ];
}

function settle(client: Client, run: Run, channel: string): void {
  const next = nextIfOpen(client.store.getState(), channel);
  void call(client, () => client.api.triage.settle(channel)).then((done) => {
    if (done && next) openEntry(next, run, client);
  });
}

function snooze(client: Client, run: Run, channel: string, until: number): void {
  const next = nextIfOpen(client.store.getState(), channel);
  void call(client, () => client.api.triage.snooze(channel, until)).then((done) => {
    if (done && next) openEntry(next, run, client);
  });
}

export const wake = (client: Client, channel: string): Promise<boolean> => call(client, () => client.api.triage.wake(channel));

export const unsettle = (client: Client, channel: string): Promise<boolean> => call(client, () => client.api.triage.unsettle(channel));

/** Opens the chat and puts you in its message box. It doesn't change the category: sending does. */
function workAgain(client: Client, run: Run, channel: string): void {
  const state = client.store.getState();
  const entry = conversationEntries(state).find((e) => e.channel === channel);
  if (entry) openEntry(entry, run, client);
  else if (channel.startsWith('ws:')) run({ type: 'open_ws', id: channel.slice(3) });
  focusComposerSoon();
}

/** The box can arrive after the chat opens (a plan's page loads its conversation first): ask until a box has the focus, for at most about two seconds. */
function focusComposerSoon(tries = 50): void {
  setTimeout(() => {
    document.dispatchEvent(new CustomEvent('beluga:focus-composer'));
    if (tries > 1 && document.activeElement?.tagName !== 'TEXTAREA') focusComposerSoon(tries - 1);
  }, 40);
}

/** Settling or snoozing the chat you're in moves you on; with no row left, you stay. */
function nextIfOpen(state: AppState, channel: string): CategoryEntry | undefined {
  const key = triageKey(state, channel);
  const here = hereOf(state);
  if (!key || !here || triageKey(state, here) !== key) return undefined;
  return nextActive(state, channel);
}

async function call(client: Client, what: () => Promise<unknown>): Promise<boolean> {
  try {
    await what();
    return true;
  } catch (err) {
    toast(client, err instanceof Error ? err.message : String(err), 'error');
    return false;
  }
}
