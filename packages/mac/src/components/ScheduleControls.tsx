import { DAY_NAMES, type ScheduleTrigger, ordinal } from '@beluga/shared/schedule/trigger.js';
import { computerWord } from '../lib/os-words.js';
import { Select } from './Select.js';
import { EVERY_CHOICES, HOURS_CHOICES, WEEK, toggleDay, withEvery } from './schedule-model.js';
import { Segmented } from './ui.js';
import s from './ScheduleControls.module.css';

/** A schedule's controls: how often, when, and what happens to a run missed while the computer slept (`hideMissed`: the caller asks that itself). Every change goes to `onChange`. */

export function ScheduleControls({ value: t, onChange: set, hideMissed }: { value: ScheduleTrigger; onChange: (next: ScheduleTrigger) => void; hideMissed?: boolean }) {
  return (
    <>
      <div className={s.every}>
        <Segmented label="How often" value={t.every} onChange={(every) => set(withEvery(t, every))} options={EVERY_CHOICES} />
      </div>
      {t.every === 'hours' ? (
        <div className={s.controlRow}>
          <span className={s.controlLabel}>Every</span>
          <Select label="Every how many hours" size="small" value={String(t.hours ?? 1)} options={HOURS_CHOICES.map((h) => ({ value: String(h), label: h === 1 ? 'hour' : `${h} hours` }))} onChange={(h) => set({ ...t, hours: Number(h) as ScheduleTrigger['hours'] & number })} />
        </div>
      ) : (
        <div className={s.controlRow}>
          <span className={s.controlLabel}>At</span>
          <input
            type="time"
            className={s.time}
            aria-label="At what time"
            value={t.at}
            onChange={(e) => {
              if (/^\d{2}:\d{2}$/.test(e.target.value)) set({ ...t, at: e.target.value });
            }}
          />
        </div>
      )}
      {t.every === 'week' ? (
        <div className={s.controlRow}>
          <span className={s.controlLabel}>On</span>
          <span className={s.days} role="group" aria-label="Days of the week">
            {WEEK.map((d) => {
              const on = (t.days?.length ? t.days : [1]).includes(d);
              return (
                <button key={d} type="button" className={s.day} aria-pressed={on} onClick={() => set({ ...t, days: toggleDay(t.days, d) })}>
                  {DAY_NAMES[d]}
                </button>
              );
            })}
          </span>
        </div>
      ) : null}
      {t.every === 'month' ? (
        <div className={s.controlRow}>
          <span className={s.controlLabel}>On the</span>
          <Select label="Day of the month" size="small" value={String(t.day ?? 1)} options={Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: ordinal(i + 1) }))} onChange={(d) => set({ ...t, day: Number(d) })} />
        </div>
      ) : null}
      {hideMissed ? null : (
        <div className={s.controlRow}>
          <span className={s.controlLabel}>If my {computerWord()} was asleep</span>
          <Select
            label={`If my ${computerWord()} was asleep`}
            size="small"
            value={t.missed}
            options={[
              { value: 'catch-up', label: 'Run as soon as it wakes', description: 'Once, however many runs it missed' },
              { value: 'skip', label: 'Skip that run', description: 'It waits for the next one' },
            ]}
            onChange={(missed) => set({ ...t, missed })}
          />
        </div>
      )}
    </>
  );
}
