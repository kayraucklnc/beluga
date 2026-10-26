import type { RunState, StepKind, TriggerKind } from '@beluga/core/sentinel/model.js';
import { RUN_STATE_INFO, STEP_INFO, isLive, scheduleSentence } from '@beluga/core/sentinel/model.js';
import { Icon, type IconName } from '../components/Icon.js';
import { Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/beluga.js';
import { TonePill } from '../plans/marks.js';
import { STEP_ICON, TRIGGER_ICON, iconOf } from './sentinel-model.js';
import r from '../tasks/task-ref.module.css';
import s from './sentinel.module.css';

/** Sentinel's small marks: an icon in a tinted circle, the steps as chips, a run's state as a pill, and the inline pill. */

/** An icon in a soft circle, tinted by what it is (`data-tone`): a trigger, a sentinel, a recipe. */
export function Disc({ icon, tone = 'neutral', size = 30, label }: { icon: IconName; tone?: 'neutral' | 'clock' | 'hand' | 'event' | 'paused' | 'claude'; size?: number; label?: string }) {
  return (
    <span className={s.disc} data-tone={tone} style={{ width: size, height: size }} {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}>
      <Icon name={icon} size={Math.round(size * 0.5)} />
    </span>
  );
}

/** A trigger's mark: a clock for schedules, a hand for by hand, the service's mark for events. */
export function TriggerDisc({ kind, paused, size }: { kind: TriggerKind; paused?: boolean; size?: number }) {
  const tone = paused ? 'paused' : kind === 'schedule' ? 'clock' : kind === 'manual' ? 'hand' : 'event';
  return <Disc icon={paused ? 'pause' : TRIGGER_ICON[kind]} tone={tone} {...(size ? { size } : {})} />;
}

/** The steps, in order, as small icon chips (each named in its tooltip). */
export function StepChips({ steps }: { steps: ReadonlyArray<{ readonly kind: StepKind; readonly name: string }> }) {
  if (!steps.length) return <span className={s.noSteps}>No steps yet</span>;
  return (
    <span className={s.chips} role="list" aria-label="Steps">
      {steps.map((st, i) => (
        <Tip key={`${st.kind}:${i}`} label={`${i + 1}. ${st.name} · ${STEP_INFO[st.kind].label}`}>
          <span className={s.chip} role="listitem" aria-label={st.name} data-kind={st.kind}>
            <Icon name={STEP_ICON[st.kind]} size={11} />
          </span>
        </Tip>
      ))}
    </span>
  );
}

/** A run's state as a pill (Running breathes with the live clock). */
export function RunPill({ state }: { state: RunState }) {
  const info = RUN_STATE_INFO[state];
  return (
    <TonePill tone={info.tone} live={isLive(state) && state !== 'needs-you'}>
      {info.label}
    </TonePill>
  );
}

/** A sentinel Claude linked in an answer (`sentinel:<id>`): its name and sentence; a click opens its page. */
export function SentinelChip({ id }: { id: string }) {
  const item = useApp((st) => st.sentinel.items.find((x) => x.id === id));
  const actions = useActions();
  if (!item) {
    return (
      <Tip label={`No sentinel ${id} here: deleted, or on someone else’s Mac`}>
        <span className={r.missing}>
          <span className={r.key}>{id}</span>
          <span>not found</span>
        </span>
      </Tip>
    );
  }
  return (
    <Tip label={`${scheduleSentence(item.trigger)}${item.paused ? ' · paused' : ''}. Click to open`}>
      <button type="button" className={r.chip} onClick={() => actions.run({ type: 'view', view: { kind: 'sentinel_page', id } })} aria-label={`Sentinel ${item.name}${item.paused ? ', paused' : ''}`}>
        <Icon name={iconOf(item.icon)} size={12} />
        <span className={r.key}>Sentinel</span>
        <span className={cx(r.chipTitle)}>{item.name}</span>
        <Icon name="arrowRight" size={10} className={r.chipGo} />
      </button>
    </Tip>
  );
}
