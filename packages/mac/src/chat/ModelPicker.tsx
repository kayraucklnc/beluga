import * as Popover from '@radix-ui/react-popover';
import { EFFORTS, type Effort } from '@klaud/shared/settings-schema.js';
import { modelLabel, modelOf } from '@klaud/ui/menus.js';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { useApi, useApp } from '../lib/klaud.js';
import s from './picker.module.css';

/** Effort in words: how long Claude thinks before it acts. */
export const EFFORT_INFO: Record<Effort, { label: string; detail: string }> = {
  low: { label: 'Quick', detail: 'Answers fast; best for small, clear asks' },
  medium: { label: 'Balanced', detail: 'Thinks enough for most everyday work' },
  high: { label: 'Thorough', detail: 'Takes its time on tricky changes' },
  xhigh: { label: 'Deep', detail: 'Works hard problems through carefully' },
  max: { label: 'Maximum', detail: 'As much thinking as it can; slowest' },
};

/** A friendlier word for a model, from its name (Opus is the most capable, Haiku the fastest). */
function flavor(value: string, label: string): string {
  const v = `${value} ${label}`.toLowerCase();
  if (v.includes('opus')) return 'Most capable';
  if (v.includes('sonnet')) return 'Fast and capable';
  if (v.includes('haiku')) return 'Fastest';
  return value ? '' : 'Claude Code chooses';
}

/**
 * The model for this conversation and how hard Claude thinks, in one popover: models as rows
 * with what they're good at, effort as five steps with plain names.
 */
export function ModelPicker({ channel }: { channel: string }) {
  const api = useApi();
  const state = useApp((st) => st);
  const conversation = channel === 'room' || channel === 'draft' ? undefined : channel;
  const current = modelOf(state, channel) ?? '';
  const effort = state.prefs.effort;
  const model = state.models.find((m) => m.value === current);
  // Some models take only some effort levels.
  const allowed = new Set((model?.efforts ?? EFFORTS) as readonly string[]);
  const chip = `${modelLabel(state, current || undefined)}${effort ? ` · ${EFFORT_INFO[effort].label}` : ''}`;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className={s.chip} aria-label="Model and effort">
          <Icon name="claude" size={12} />
          {chip}
          <Icon name="chevronDown" size={9} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={s.popover} side="top" align="start" sideOffset={8} collisionPadding={12}>
          <div className={s.heading}>
            Model
            <span className={s.scope}>{conversation ? 'for this conversation' : 'for new conversations'}</span>
          </div>
          <div className={s.models} role="radiogroup" aria-label="Model">
            {state.models.map((m) => {
              const on = m.value === current;
              return (
                <button key={m.value || 'default'} type="button" role="radio" aria-checked={on} className={cx(s.model, on && s.modelOn)} onClick={() => void api.workbench.setModel(conversation, m.value)}>
                  <span className={s.radio}>{on ? <Icon name="check" size={11} /> : null}</span>
                  <span className={s.modelText}>
                    <span className={s.modelName}>
                      {m.label}
                    </span>
                    <span className={s.modelDesc}>{m.description || flavor(m.value, m.label)}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className={s.heading}>
            Thinking
            <span className={s.scope}>for every conversation</span>
          </div>
          <div className={s.meterRow}>
            <button type="button" role="radio" aria-checked={!effort} className={cx(s.auto, !effort && s.autoOn)} onClick={() => void api.session.setPrefs({ effort: undefined })}>
              Auto
            </button>
            <div className={s.meter} role="radiogroup" aria-label="Thinking effort">
              {EFFORTS.map((e, i) => {
                const level = effort ? EFFORTS.indexOf(effort) : -1;
                return (
                  <button key={e} type="button" role="radio" aria-checked={effort === e} disabled={!allowed.has(e)} className={s.step} onClick={() => void api.session.setPrefs({ effort: e })}>
                    <span className={cx(s.bar, i <= level && s.barOn)} style={{ height: 6 + i * 5 }} />
                    <span className={cx(s.stepLabel, effort === e && s.stepLabelOn)}>{EFFORT_INFO[e].label}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className={s.effortDetail}>
            <strong>{effort ? EFFORT_INFO[effort].label : 'Auto'}</strong> · {effort ? EFFORT_INFO[effort].detail : 'Claude decides how much to think, case by case'}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
