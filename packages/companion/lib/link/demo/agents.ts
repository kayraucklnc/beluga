import type { AgentPickerView } from '../protocol';

/**
 * The demo's agent picker (BLG-446): Claude with its models, Codex set up too (so a worktree shows
 * running on another agent), and a local model not set up yet, saying what's missing.
 */
const GROUPS: AgentPickerView['groups'] = [
  {
    runtime: 'claude',
    label: 'Claude',
    available: true,
    isDefault: true,
    current: true,
    models: [
      { value: '', label: 'Default', description: "Claude Code's choice", on: true },
      { value: 'opus', label: 'Opus', description: 'most capable, for complex work', on: false },
      { value: 'sonnet', label: 'Sonnet', description: 'fast and very capable', on: false },
      { value: 'haiku', label: 'Haiku', description: 'fastest, for quick tasks', on: false },
    ],
  },
  {
    runtime: 'codex',
    label: 'Codex',
    available: true,
    isDefault: false,
    current: false,
    models: [
      { value: 'gpt-5-codex', label: 'GPT-5 Codex', description: 'tuned for code', on: false },
      { value: 'gpt-5', label: 'GPT-5', description: 'general purpose', on: false },
    ],
  },
  { runtime: 'local', label: 'Local model', available: false, why: 'No local model endpoint is set', isDefault: false, current: false, models: [] },
];

/** The picker with `model` of `runtime` picked (the chip says the runtime when it isn't your default). */
export function demoPicker(runtime = 'claude', model = ''): AgentPickerView {
  const groups = GROUPS.map((g) => ({ ...g, current: g.runtime === runtime, models: g.models.map((m) => ({ ...m, on: g.runtime === runtime && m.value === model })) }));
  const group = groups.find((g) => g.current);
  const picked = group?.models.find((m) => m.on)?.label ?? 'Default';
  return { runtime, label: group?.isDefault ? picked : `${group?.label ?? runtime} · ${picked}`, groups };
}
