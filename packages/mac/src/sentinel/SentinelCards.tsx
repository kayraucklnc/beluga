import { useRef, useState } from 'react';
import {
  type ClaudeStep,
  type NotifyStep,
  type ScheduleTrigger,
  type ScriptStep,
  type Sentinel,
  type SentinelPatch,
  type Step,
  DAY_NAMES,
  STEP_INFO,
  accessAllows,
  ordinal,
  scheduleSentence,
  stepAvailable,
  stepRefusal,
  stepSentence,
} from '@beluga/core/sentinel/model.js';
import { Checkbox, TextArea, TextInput } from '../components/FormSheet.js';
import { Icon } from '../components/Icon.js';
import { Select } from '../components/Select.js';
import { type ActionItem, ActionsDropdown } from '../components/SpecMenu.js';
import { Button, IconButton, Segmented } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import {
  CLAUDE_PRESETS,
  EVERY_CHOICES,
  HOURS_CHOICES,
  LATER,
  STEP_ICON,
  TEMPLATE_HELP,
  WEEK,
  duplicateStep,
  moveStep,
  newStep,
  patchStep,
  stepChoices,
  toggleDay,
  triggerChoices,
  triggerOfKind,
  withEvery,
} from './sentinel-model.js';
import { useDraft } from './use-draft.js';
import s from './sentinel.module.css';

/** The sentinel page's editor: When it runs, and its Steps. Everything saves as you change it. */

export type Save = (patch: SentinelPatch) => void;

const nameOf =
  (items: readonly Sentinel[]) =>
  (id: string): string | undefined =>
    items.find((i) => i.id === id)?.name;

export function WhenCard({ item, save }: { item: Sentinel; save: Save }) {
  const items = useApp((st) => st.sentinel.items);
  const t = item.trigger;
  const choices = triggerChoices();
  return (
    <section className={s.card} aria-label="When">
      <header className={s.cardHead}>
        <h3 className={s.cardTitle}>When</h3>
      </header>
      <p className={s.sentence} data-testid="sentinel-sentence">
        {scheduleSentence(t, nameOf(items))}
      </p>
      <div className={s.controls}>
        <div className={s.controlRow}>
          <span className={s.controlLabel}>What starts it</span>
          <Select
            label="What starts it"
            size="small"
            value={t.kind}
            options={choices}
            onChange={(k) => {
              const next = triggerOfKind(k, t);
              if (next) save({ trigger: next });
            }}
          />
        </div>
        {t.kind === 'schedule' ? <ScheduleControls t={t} save={save} /> : null}
        {t.kind === 'manual' ? <p className={s.hint}>It runs only when you press Run Now: here, on its row, or from your phone.</p> : null}
        {t.kind !== 'schedule' && t.kind !== 'manual' ? (
          <p className={s.hint}>
            Watching for this comes with a later update. Until then it runs when you press Run Now; pick “On a schedule” to run it by the clock.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function ScheduleControls({ t, save }: { t: ScheduleTrigger; save: Save }) {
  const set = (next: ScheduleTrigger): void => save({ trigger: next });
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
      <div className={s.controlRow}>
        <span className={s.controlLabel}>If my Mac was asleep</span>
        <Select
          label="If my Mac was asleep"
          size="small"
          value={t.missed}
          options={[
            { value: 'catch-up', label: 'Run as soon as it wakes', description: 'Once, however many runs it missed' },
            { value: 'skip', label: 'Skip that run', description: 'It waits for the next one' },
          ]}
          onChange={(missed) => set({ ...t, missed })}
        />
      </div>
    </>
  );
}

export function StepsCard({ item, save }: { item: Sentinel; save: Save }) {
  const items = useApp((st) => st.sentinel.items);
  const [open, setOpen] = useState<string>();
  const latest = useRef(item);
  latest.current = item;
  const setSteps = (steps: Parameters<Save>[0]['steps']): void => save({ steps });
  const change = (id: string, patch: Partial<Step>): void => setSteps(patchStep(latest.current.steps, id, patch));
  const add: ActionItem[] = stepChoices(item.access).map((c) => ({
    label: c.label,
    icon: STEP_ICON[c.kind],
    hint: c.hint,
    disabled: c.disabled,
    onSelect: () => {
      if (c.kind !== 'claude' && c.kind !== 'script' && c.kind !== 'notify') return;
      setSteps([...latest.current.steps, newStep(c.kind)]);
      // The new one opens (its id comes back from the daemon: open the last one then).
      setOpen('last');
    },
  }));
  const steps = item.steps;
  return (
    <section className={s.card} aria-label="Steps">
      <header className={s.cardHead}>
        <h3 className={s.cardTitle}>Steps</h3>
      </header>
      {steps.length ? (
        <div className={s.steps} role="list">
          {steps.map((st, i) => (
            <StepItem
              key={st.id}
              step={st}
              index={i}
              count={steps.length}
              open={open === st.id || (open === 'last' && i === steps.length - 1)}
              toggle={() => setOpen(open === st.id || (open === 'last' && i === steps.length - 1) ? undefined : st.id)}
              item={item}
              nameOf={nameOf(items)}
              change={(patch) => change(st.id, patch)}
              move={(by) => setSteps(moveStep(latest.current.steps, i, by))}
              duplicate={() => setSteps(duplicateStep(latest.current.steps, i))}
              remove={() => setSteps(latest.current.steps.filter((x) => x.id !== st.id))}
            />
          ))}
        </div>
      ) : (
        <p className={s.empty}>No steps yet. Add what it does, in order: ask Claude, run a script, tell you.</p>
      )}
      <div className={s.addStep}>
        <ActionsDropdown items={add} align="start">
          <Button size="small" icon="plus">
            Add a Step
          </Button>
        </ActionsDropdown>
      </div>
    </section>
  );
}

function StepItem({
  step,
  index,
  count,
  open,
  toggle,
  item,
  nameOf,
  change,
  move,
  duplicate,
  remove,
}: {
  step: Step;
  index: number;
  count: number;
  open: boolean;
  toggle: () => void;
  item: Sentinel;
  nameOf: (id: string) => string | undefined;
  change: (patch: Partial<Step>) => void;
  move: (by: number) => void;
  duplicate: () => void;
  remove: () => void;
}) {
  const name = useDraft(step.name, (v) => {
    const next = v.replace(/\s+/g, ' ').trim();
    if (next && next !== step.name) change({ name: next });
  });
  const later = !stepAvailable(step.kind);
  const menu: ActionItem[] = [
    { label: 'Move Up', icon: 'up', disabled: index === 0, onSelect: () => move(-1) },
    { label: 'Move Down', icon: 'chevronDown', disabled: index === count - 1, onSelect: () => move(1) },
    { label: 'Duplicate', icon: 'copy', separate: true, disabled: later, onSelect: duplicate },
    { label: 'Remove', danger: true, separate: true, onSelect: remove },
  ];
  return (
    <div className={s.step} role="listitem" data-step={step.kind}>
      <div
        className={s.stepRow}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('input, button')) return;
          if (!later) toggle();
        }}
      >
        <span className={s.stepIndex}>{index + 1}</span>
        <span className={s.chip} data-kind={step.kind} aria-hidden="true">
          <Icon name={STEP_ICON[step.kind]} size={11} />
        </span>
        <span className={s.stepText}>
          <input
            className={s.stepName}
            value={name.text}
            aria-label={`Step ${index + 1}’s name`}
            spellCheck={false}
            onChange={(e) => name.change(e.target.value)}
            onBlur={name.flush}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
          <span className={s.stepLine}>
            {STEP_INFO[step.kind].label} · {stepSentence(step, nameOf)}
          </span>
          {later ? <span className={s.stepLater}>{LATER}: a run stops here until then.</span> : null}
        </span>
        {later ? null : <IconButton icon={open ? 'chevronUp' : 'chevronDown'} label={open ? 'Fold' : 'Show its fields'} onClick={toggle} aria-expanded={open} />}
        <ActionsDropdown items={menu}>
          <IconButton icon="more" label={`More for “${step.name}”`} />
        </ActionsDropdown>
      </div>
      {open && !later ? (
        <div className={s.stepFields}>
          {step.kind === 'claude' ? <ClaudeFields step={step} item={item} change={change} /> : null}
          {step.kind === 'script' ? <ScriptFields step={step} change={change} /> : null}
          {step.kind === 'notify' ? <NotifyFields step={step} change={change} /> : null}
        </div>
      ) : null}
    </div>
  );
}

const WHERE_INFO: ReadonlyArray<{ readonly value: ClaudeStep['where']; readonly label: string; readonly description: string }> = [
  { value: 'project', label: 'In the project', description: 'A new chat in the project’s main folder; Claude reads and reports, never changes files' },
  { value: 'worktree', label: 'In a new worktree', description: 'Its own branch: Claude edits, commits and runs the tests; later steps share it' },
  { value: 'mac', label: 'On Your Mac', description: 'A chat in Your Mac, for things about the Mac itself' },
];

function ClaudeFields({ step, item, change }: { step: ClaudeStep; item: Sentinel; change: (patch: Partial<ClaudeStep>) => void }) {
  const models = useApp((st) => st.models);
  const prompt = useDraft(step.prompt, (v) => v !== step.prompt && change({ prompt: v }));
  const where = WHERE_INFO.find((w) => w.value === step.where);
  return (
    <>
      <div className={s.field}>
        <span className={s.fieldLabel}>What Claude does</span>
        <div className={s.presets} role="group" aria-label="Start from">
          {CLAUDE_PRESETS.map((p) => (
            <button key={p.id} type="button" className={s.preset} onClick={() => prompt.change(p.prompt)}>
              {p.label}
            </button>
          ))}
        </div>
        <TextArea className={s.prompt} value={prompt.text} onChange={prompt.change} onBlur={prompt.flush} rows={6} aria-label="Claude’s prompt" placeholder="What should Claude do each run? Say when to stop: “If nothing changed, say so and stop.”" />
        <span className={s.help}>{TEMPLATE_HELP}</span>
      </div>
      <div className={s.controlRow}>
        <span className={s.controlLabel}>Where</span>
        <Select
          label="Where Claude runs"
          size="small"
          value={step.where}
          options={WHERE_INFO.map((w) => {
            const why = stepRefusal(item.access, 'claude', w.value);
            return { value: w.value, label: w.label, description: why ?? w.description, disabled: !accessAllows(item.access, 'claude', w.value) };
          })}
          onChange={(w) => change({ where: w })}
        />
      </div>
      {where ? <p className={s.hint}>{where.description}.</p> : null}
      <div className={s.controlRow}>
        <span className={s.controlLabel}>Model</span>
        <Select
          label="Model"
          size="small"
          value={step.model ?? ''}
          options={(models.length ? models : [{ value: '', label: 'Default', description: '' }]).map((m) => ({ value: m.value, label: m.label || 'Default', ...(m.description ? { description: m.description } : {}) }))}
          onChange={(m) => {
            const { model: _m, ...rest } = step;
            change(m ? { model: m } : ({ ...rest, model: undefined } as Partial<ClaudeStep>));
          }}
        />
      </div>
    </>
  );
}

const TIMEOUTS = [30, 60, 120, 300, 600, 900, 1800, 3600] as const;
const timeoutLabel = (sec: number): string => (sec < 60 ? `${sec} seconds` : sec < 3600 ? `${sec / 60} minute${sec === 60 ? '' : 's'}` : '1 hour');

function ScriptFields({ step, change }: { step: ScriptStep; change: (patch: Partial<ScriptStep>) => void }) {
  const command = useDraft(step.command, (v) => v !== step.command && change({ command: v }));
  const timeouts: number[] = TIMEOUTS.includes(step.timeoutSec as (typeof TIMEOUTS)[number]) ? [...TIMEOUTS] : [...TIMEOUTS, step.timeoutSec].sort((a, b) => a - b);
  return (
    <>
      <div className={s.field}>
        <span className={s.fieldLabel}>Command</span>
        <TextInput value={command.text} onChange={command.change} onBlur={command.flush} mono placeholder="npm test" aria-label="Command" />
        <span className={s.help}>One shell line or a script’s path; a non-zero exit stops the run. $VAR from Settings › Environment; $SENTINEL_PREVIOUS has the step before’s output.</span>
      </div>
      <div className={s.controlRow}>
        <span className={s.controlLabel}>Runs in</span>
        <Select
          label="Runs in"
          size="small"
          value={step.cwd}
          options={[
            { value: 'project', label: 'The project’s main folder' },
            { value: 'home', label: 'Your home folder' },
          ]}
          onChange={(cwd) => change({ cwd })}
        />
      </div>
      <div className={s.controlRow}>
        <span className={s.controlLabel}>Stop it after</span>
        <Select label="Stop it after" size="small" value={String(step.timeoutSec)} options={timeouts.map((n) => ({ value: String(n), label: timeoutLabel(n) }))} onChange={(v) => change({ timeoutSec: Number(v) })} />
      </div>
    </>
  );
}

function NotifyFields({ step, change }: { step: NotifyStep; change: (patch: Partial<NotifyStep>) => void }) {
  const title = useDraft(step.title ?? '', (v) => v !== (step.title ?? '') && change({ title: v }));
  const body = useDraft(step.body ?? '', (v) => v !== (step.body ?? '') && change({ body: v }));
  return (
    <>
      <div className={s.field}>
        <span className={s.fieldLabel}>Title</span>
        <TextInput value={title.text} onChange={title.change} onBlur={title.flush} placeholder="{{sentinel}} (the sentinel’s name)" aria-label="Title" />
      </div>
      <div className={s.field}>
        <span className={s.fieldLabel}>Says</span>
        <TextArea value={body.text} onChange={body.change} onBlur={body.flush} rows={2} placeholder="The report’s first line" aria-label="What it says" />
        <span className={s.help}>{TEMPLATE_HELP}</span>
      </div>
      <Checkbox checked={step.phone} onChange={(phone) => change({ phone })} label="On my phone too" detail="With the report, if your phone is paired" />
    </>
  );
}
