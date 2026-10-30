import * as Popover from '@radix-ui/react-popover';
import { EFFORTS, type Effort } from '@beluga/shared/settings-schema.js';
import { useState } from 'react';
import type { AgentRef } from '@beluga/protocol.js';
import { type AgentPicker, type PickerGroup, agentPicker, pickAction } from '@beluga/shared/agent-picker.js';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { useApi, useApp } from '../lib/beluga.js';
import s from './picker.module.css';

/** Effort, named as Claude Code names it, with what it means. */
export const EFFORT_INFO: Record<Effort, { label: string; detail: string }> = {
  low: { label: 'Low', detail: 'Answers fast; best for small, clear asks' },
  medium: { label: 'Medium', detail: 'Thinks enough for most everyday work' },
  high: { label: 'High', detail: 'Takes its time on tricky changes' },
  xhigh: { label: 'Extra High', detail: 'Works hard problems through carefully' },
  max: { label: 'Max', detail: 'As much thinking as it can; slowest' },
};

/** A friendlier word for a model, from its name (Opus is the most capable, Haiku the fastest). */
function flavor(value: string, label: string, runtime: string): string {
  const v = `${value} ${label}`.toLowerCase();
  if (v.includes('opus')) return 'Most capable';
  if (v.includes('sonnet')) return 'Fast and capable';
  if (v.includes('haiku')) return 'Fastest';
  return value ? '' : `${runtime} chooses`;
}

const samePicker = (a: AgentPicker, b: AgentPicker): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The agent for this conversation, and how hard it thinks, in one popover (BLG-446): your default
 * agent's models first, as rows with what they're good at; the other runtimes one tap away under
 * Other agents, each with its models, or greyed with what's missing. Effort is five steps with plain
 * names. `draft`: a new worktree's pick (it has no conversation yet), kept by the New Worktree box.
 */
export function ModelPicker({ channel, draft, onDraft }: { channel: string; draft?: AgentRef; onDraft?: (agent: AgentRef | undefined) => void }) {
  const api = useApi();
  // Only what the picker shows (not the whole state): not drawn again on every streamed event (KLD-48).
  const picker = useApp((st) => agentPicker(st, channel, 'claude', draft), samePicker);
  const effort = useApp((st) => st.prefs.effort);
  const [others, setOthers] = useState(() => picker.groups.some((g) => !g.isDefault && g.current));
  const conversation = picker.conversation;
  const groups = picker.groups;
  const home = groups.find((g) => g.isDefault);
  const rest = groups.filter((g) => !g.isDefault);
  const model = groups.find((g) => g.current)?.models.find((m) => m.on);
  // Some models take only some effort levels.
  const allowed = new Set((model?.efforts ?? EFFORTS) as readonly string[]);
  const label = picker.label;
  const chip = `${label}${effort ? ` · ${EFFORT_INFO[effort].label}` : ''}`;
  const pick = (g: PickerGroup, value: string): void => {
    if (onDraft && !conversation) {
      // A new worktree: your default's model is the default for new ones; another runtime is this worktree's own.
      if (g.isDefault) {
        onDraft(undefined);
        void api.workbench.setModel(undefined, value);
      } else onDraft({ runtime: g.runtime, label: g.label, ...(value ? { model: value } : {}) });
      return;
    }
    const action = pickAction(picker, g, value);
    if (action?.kind === 'model') void api.workbench.setModel(conversation, action.value);
    else if (action?.kind === 'agent' && conversation) void api.workbench.setAgent(conversation, action.agent);
  };
  const rows = (g: PickerGroup) => (
    <div className={s.models} role="radiogroup" aria-label={`${g.label} models`}>
      {g.models.map((m) => (
        <button key={m.value || 'default'} type="button" role="radio" aria-checked={m.on} disabled={Boolean(m.why) && !m.on} title={m.why} className={cx(s.model, m.on && s.modelOn, m.why && s.modelOff)} onClick={() => pick(g, m.value)}>
          <span className={s.radio}>{m.on ? <Icon name="check" size={11} /> : null}</span>
          <span className={s.modelText}>
            <span className={s.modelName}>{m.label}</span>
            <span className={s.modelDesc}>{m.why ?? (m.description || flavor(m.value, m.label, g.label))}</span>
          </span>
        </button>
      ))}
    </div>
  );
  // Narrow (a side panel): the effort alone, the whole of it in the tooltip; never two lines.
  const words = effort ? (
    <>
      <span className={s.chipModel}>{label} · </span>
      {EFFORT_INFO[effort].label}
    </>
  ) : (
    label
  );
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className={s.chip} aria-label="Agent, model and effort" title={chip} data-shrink="">
          <Icon name={picker.runtime === 'claude' ? 'claude' : 'sparkles'} size={12} />
          <span className={s.chipText}>{words}</span>
          <Icon name="chevronDown" size={9} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={s.popover} side="top" align="start" sideOffset={8} collisionPadding={12}>
          <div className={s.heading}>
            {home?.label ?? 'Model'}
            <span className={s.scope}>{conversation ? 'for this conversation' : onDraft ? 'for this worktree' : 'for new conversations'}</span>
          </div>
          {home ? (home.available ? rows(home) : <div className={s.why}>{home.why}</div>) : null}
          {rest.length ? (
            <>
              <button type="button" className={s.others} aria-expanded={others} onClick={() => setOthers(!others)}>
                <Icon name={others ? 'chevronDown' : 'chevronRight'} size={10} />
                Other agents
              </button>
              {others
                ? rest.map((g) => (
                    <div key={g.runtime} className={cx(s.group, !g.available && s.groupOff)} aria-disabled={!g.available || undefined}>
                      <div className={s.groupName}>{g.label}</div>
                      {g.available ? rows(g) : <div className={s.why}>{g.why}</div>}
                    </div>
                  ))
                : null}
            </>
          ) : null}
          <div className={s.heading}>
            Thinking
            <span className={s.scope}>for every conversation</span>
          </div>
          <div className={s.meterRow}>
            <button type="button" role="radio" aria-checked={!effort} className={cx(s.auto, !effort && s.autoOn)} onClick={() => void api.session.setPrefs({ effort: null })}>
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
            <strong>{effort ? EFFORT_INFO[effort].label : 'Auto'}</strong> · {effort ? EFFORT_INFO[effort].detail : 'Your agent decides how much to think, case by case'}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
