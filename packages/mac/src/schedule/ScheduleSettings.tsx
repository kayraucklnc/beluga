import { useState } from 'react';
import type { ScheduleView } from '@beluga/core/schedule/model.js';
import { assistantChatOf, isAssistant } from '@beluga/shared/assistant.js';
import { Icon } from '../components/Icon.js';
import { ActionsDropdown, type ActionItem } from '../components/SpecMenu.js';
import { Dot, IconButton, Tip } from '../components/ui.js';
import { Group, Row, Switch } from '../dialogs/settings-controls.js';
import { useActions } from '../lib/actions.js';
import { useApi, useApp, useBeluga } from '../lib/beluga.js';
import { openSheet } from '../lib/sheets.js';
import { sameDeep } from '../lib/stable.js';
import { useClock } from '../lib/window-active.js';
import { chatName, rowStatus, scheduleLine, scheduleProblem, statusTone, statusWords } from './schedule-model.js';
import c from './schedule.module.css';

const LINE_EVERY_MS = 30_000;

/** Settings › Agent › Schedules: the setting, and every schedule on this computer. */
export function ScheduleSettings() {
  const api = useApi();
  const on = useApp((st) => st.prefs.chatSchedules);
  const items = useApp((st) => st.schedules, sameDeep);
  const now = useClock(on && items.length > 0, LINE_EVERY_MS);
  return (
    <div id="settings-schedules" tabIndex={-1} className={c.anchor}>
      <Group title="Schedules">
        <Row label="Schedules in chats" detail="Your agent runs a prompt in a chat, on its own. Each run continues that chat, on this computer.">
          <Switch label="Schedules in chats" on={on} onChange={(v) => void api.session.setPrefs({ chatSchedules: v })} />
        </Row>
        {on ? items.map((item) => <ScheduleItemRow key={item.id} item={item} now={now} />) : null}
        {on && !items.length ? <div className={c.noneYet}>No schedules yet. In a chat, type /schedule to make one.</div> : null}
      </Group>
    </div>
  );
}

function ScheduleItemRow({ item, now }: { item: ScheduleView; now: number }) {
  const api = useApi();
  const actions = useActions();
  const { ui } = useBeluga();
  const chat = useApp((st) => chatName(st, item.channel));
  const [failure, setFailure] = useState<string>();
  const act = (work: Promise<unknown>): void => {
    setFailure(undefined);
    work.catch((err: unknown) => setFailure(err instanceof Error ? err.message : String(err)));
  };
  const status = rowStatus(item);
  const line = scheduleLine(item, now);
  const problem = failure ?? scheduleProblem(item);
  const open = (): void => {
    ui.patch({ settings: undefined });
    if (isAssistant(item.channel)) actions.run({ type: 'view', view: { kind: 'assistant', chat: assistantChatOf(item.channel)! } });
    else actions.run({ type: 'open_ws', id: item.channel.slice(3) });
  };
  // The editor is a sheet of the window, under Settings: Settings closes first.
  const edit = (): void => {
    ui.patch({ settings: undefined });
    openSheet({ kind: 'schedule', channel: item.channel, id: item.id });
  };
  const remove = (): void => openSheet({ kind: 'confirm', title: `Remove “${item.title}”?`, message: 'It stops running in its chat. A run under way finishes. You can’t undo this.', confirm: 'Remove', destructive: true, run: () => act(api.schedule.remove(item.id)) });
  const more: ActionItem[] = [
    { label: 'Edit', onSelect: edit },
    { label: item.enabled ? 'Pause' : 'Resume', onSelect: () => act(api.schedule.setEnabled(item.id, !item.enabled)) },
    { label: 'Run now', disabled: status === 'running', onSelect: () => act(api.schedule.runNow(item.id)) },
    { label: 'Remove', danger: true, separate: true, onSelect: remove },
  ];
  return (
    <div className={c.settingsRow} data-schedule-setting={item.title} data-status={status}>
      <Tip label={statusWords(status)}>
        <span className={c.settingsDot}>
          <Dot tone={statusTone(status)} live={status === 'running'} />
        </span>
      </Tip>
      <div className={c.body}>
        <div className={c.title}>{item.title}</div>
        <Tip label={line}>
          <div className={c.line}>{line}</div>
        </Tip>
        {problem ? (
          <div className={c.problem} role="status">
            {problem}
          </div>
        ) : null}
      </div>
      <button type="button" className={c.chatLink} title={`Open ${chat}`} onClick={open}>
        <span>{chat}</span>
        <Icon name="chevronRight" size={9} />
      </button>
      <ActionsDropdown items={more}>
        <IconButton icon="more" label={`More for ${item.title}`} />
      </ActionsDropdown>
    </div>
  );
}
