import { memo, useState } from 'react';
import type { LogItem, ScheduleMark } from '@beluga/core/store.js';
import { Icon } from '../components/Icon.js';
import { Button, cx } from '../components/ui.js';
import { useApi, useApp } from '../lib/beluga.js';
import { runWords } from './schedule-model.js';
import c from './schedule.module.css';

type ScheduleItem = Extract<LogItem, { type: 'system' }> & { readonly schedule: ScheduleMark };

export const isScheduleItem = (l: LogItem): l is ScheduleItem => l.type === 'system' && Boolean((l as { schedule?: ScheduleMark }).schedule);

/** A schedule's line in its chat: a quiet divider, never a person's message. Its prompt folds; a pause after failures offers Resume. */
export const ScheduleLine = memo(function ScheduleLine({ item }: { item: ScheduleItem }) {
  const m = item.schedule;
  return m.paused ? <PausedLine item={item} /> : <RunLine item={item} />;
});

function RunLine({ item }: { item: ScheduleItem }) {
  const m = item.schedule;
  const [open, setOpen] = useState(false);
  return (
    <div className={c.divider} data-schedule-run={m.title} role="separator" aria-label={item.text}>
      <div className={c.rule}>
        <button type="button" className={c.runLabel} aria-expanded={open} title={open ? 'Fold the prompt' : 'Show the prompt'} onClick={() => setOpen(!open)}>
          <Icon name="clock" size={11} />
          <span className={c.runTitle}>{m.title}</span>
          <span className={c.runWords}>· {runWords(m).join(' · ')}</span>
          <Icon name="chevronRight" size={9} className={cx(c.chev, open && c.chevOpen)} />
        </button>
      </div>
      {open ? <div className={c.runPrompt}>{m.prompt}</div> : null}
    </div>
  );
}

function PausedLine({ item }: { item: ScheduleItem }) {
  const m = item.schedule;
  const api = useApi();
  const waiting = useApp((st) => st.schedules.some((x) => x.id === m.id && !x.enabled));
  const [failure, setFailure] = useState<string>();
  const resume = (): void => {
    setFailure(undefined);
    api.schedule.setEnabled(m.id, true).catch((err: unknown) => setFailure(err instanceof Error ? err.message : String(err)));
  };
  return (
    <div className={c.divider} data-schedule-paused={m.title} role="separator" aria-label={item.text}>
      <div className={cx(c.rule, c.ruleWarn)}>
        <span className={c.runLabel}>
          <Icon name="clock" size={11} />
          <span className={c.runTitle}>{item.text.replace(/^Schedule · /, '')}</span>
        </span>
        {waiting ? (
          <Button size="small" variant="quiet" onClick={resume}>
            Resume
          </Button>
        ) : null}
      </div>
      {failure ? <div className={c.problem}>{failure}</div> : null}
    </div>
  );
}
