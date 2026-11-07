import { useState } from 'react';
import type { ScheduleView } from '@beluga/core/schedule/model.js';
import { peerName } from '@beluga/core/store.js';
import type { GuestSchedule } from '@beluga/protocol.js';
import { Icon } from '../components/Icon.js';
import { Button, Dot, Tip } from '../components/ui.js';
import { Switch } from '../dialogs/settings-controls.js';
import { Panel } from '../layout/InspectorPanel.js';
import { useApi, useApp, useBeluga } from '../lib/beluga.js';
import { openSettings } from '../lib/native-routes.js';
import { openSheet } from '../lib/sheets.js';
import { sameDeep } from '../lib/stable.js';
import { useClock } from '../lib/window-active.js';
import { rowStatus, scheduleLine, sentLine, scheduleProblem, statusTone, statusWords } from './schedule-model.js';
import c from './schedule.module.css';

const NONE: readonly ScheduleView[] = [];
const NONE_SHARED: readonly GuestSchedule[] = [];
const LINE_EVERY_MS = 30_000;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The Info panel's Schedules: what wakes this chat by itself. It shows only when the chat has some. */
export function ScheduleSection({ channel }: { channel: string }) {
  const { ui } = useBeluga();
  const items = useApp((st) => (st.prefs.chatSchedules ? st.schedules.filter((x) => x.channel === channel) : NONE), sameDeep);
  const now = useClock(items.length > 0, LINE_EVERY_MS);
  if (!items.length) return null;
  const all = (
    <Tip label="Every schedule on this computer">
      <Button size="small" variant="quiet" icon="gear" aria-label="All schedules" onClick={() => openSettings(ui, 'claude', 'settings-schedules')} />
    </Tip>
  );
  return (
    <Panel title={items.length > 1 ? `Schedules · ${items.length}` : 'Schedules'} action={all}>
      {items.map((item) => (
        <ScheduleRow key={item.id} item={item} now={now} />
      ))}
    </Panel>
  );
}

/** The same section in a chat someone shared with you: what wakes it, with no controls, because their computer runs it. */
export function SharedScheduleSection({ owner, id }: { owner: string; id: string }) {
  const items = useApp((st) => st.sharedSchedules[id] ?? NONE_SHARED, sameDeep);
  const ownerName = useApp((st) => peerName(st, owner));
  const now = useClock(items.length > 0, LINE_EVERY_MS);
  if (!items.length) return null;
  return (
    <Panel title={items.length > 1 ? `Schedules · ${items.length}` : 'Schedules'}>
      <div className={c.where}>Runs on {ownerName}’s computer</div>
      {items.map((item) => {
        const line = sentLine(item, now);
        return (
          <div key={item.id} className={c.row} data-schedule={item.title} data-status={item.status}>
            <Tip label={statusWords(item.status)}>
              <span className={c.mark}>
                <Icon name="clock" size={14} />
                <span className={c.markDot}>
                  <Dot tone={statusTone(item.status)} live={item.status === 'running'} />
                </span>
              </span>
            </Tip>
            <div className={c.body}>
              <Tip label={item.prompt}>
                <div className={c.title}>{item.title}</div>
              </Tip>
              <Tip label={line}>
                <div className={c.line}>{line}</div>
              </Tip>
              {item.pausedReason ? (
                <div className={c.problem} role="status">
                  {item.pausedReason}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </Panel>
  );
}

function ScheduleRow({ item, now }: { item: ScheduleView; now: number }) {
  const api = useApi();
  const [failure, setFailure] = useState<string>();
  const act = (work: Promise<unknown>): void => {
    setFailure(undefined);
    work.catch((err: unknown) => setFailure(errorText(err)));
  };
  const status = rowStatus(item);
  const line = scheduleLine(item, now);
  const problem = failure ?? scheduleProblem(item);
  return (
    <div className={c.row} data-schedule={item.title} data-status={status}>
      <Tip label={statusWords(status)}>
        <span className={c.mark}>
          <Icon name="clock" size={14} />
          <span className={c.markDot}>
            <Dot tone={statusTone(status)} live={status === 'running'} />
          </span>
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
        <div className={c.actions}>
          <Button size="small" variant="quiet" onClick={() => openSheet({ kind: 'schedule', channel: item.channel, id: item.id })}>
            Edit
          </Button>
          <Button size="small" variant="quiet" disabled={status === 'running'} onClick={() => act(api.schedule.runNow(item.id))}>
            Run now
          </Button>
        </div>
      </div>
      <Switch label={`${item.title} is on`} on={item.enabled} onChange={(on) => act(api.schedule.setEnabled(item.id, on))} />
    </div>
  );
}
