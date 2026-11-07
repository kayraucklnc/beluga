import { useState } from 'react';
import { Alert } from '../components/Alert.js';
import { Field, FormSheet, Popup, TextArea, TextInput } from '../components/FormSheet.js';
import { ScheduleControls } from '../components/ScheduleControls.js';
import { Button, Segmented } from '../components/ui.js';
import { useApi, useApp, useBeluga } from '../lib/beluga.js';
import { computerWord } from '../lib/os-words.js';
import { WHEN_KINDS, draftOf, draftProblem, inputOf, isDirty, newDraft, type ScheduleDraft } from './schedule-model.js';
import c from './schedule.module.css';

const MISSED = [
  { value: 'catch-up', label: 'Run once when it is back', description: 'Once, however many runs it missed' },
  { value: 'skip', label: 'Skip that run', description: 'It waits for the next one' },
] as const;
const IF_BUSY = [
  { value: 'hold', label: 'Wait until it is free', description: 'One run waits, however many come due' },
  { value: 'skip', label: 'Skip that run', description: 'The chat gets one line that says so' },
] as const;
const EACH_RUN = [
  { value: 'continue', label: 'Continue this conversation', description: 'The agent keeps what this chat already said' },
  { value: 'fresh', label: 'Fresh session', description: 'The agent starts with no memory of this chat' },
] as const;

/** Make or change a schedule of one chat: from /schedule, a row's Edit and ⌘K. A form with changes asks before it closes. */
export function ScheduleEditor({ channel, id, close }: { channel: string; id?: string; close: () => void }) {
  const api = useApi();
  const { client } = useBeluga();
  const saved = useApp((st) => st.schedules.find((x) => x.id === id));
  const [start] = useState(() => (saved ? draftOf(saved, Date.now()) : newDraft(Date.now())));
  const [draft, setDraft] = useState(start);
  const [asking, setAsking] = useState<'discard' | 'remove'>();
  const set = (patch: Partial<ScheduleDraft>): void => setDraft((d) => ({ ...d, ...patch }));
  const problem = draftProblem(draft, Date.now());
  const submit = async (): Promise<string | void> => {
    const input = inputOf(draft);
    if (!input) return problem;
    const { enabled: _enabled, ...patch } = input;
    await (id ? api.schedule.update(id, patch) : api.schedule.create(channel, input));
    close();
  };
  const remove = (): void => {
    if (!id) return;
    api.schedule.remove(id).then(close, (err: unknown) => {
      setAsking(undefined);
      client.store.dispatch({ type: 'toast', text: err instanceof Error ? err.message : String(err), level: 'warn' });
    });
  };
  const cancel = (): void => (isDirty(draft, start) ? setAsking('discard') : close());
  return (
    <>
      <FormSheet
        title={id ? 'Edit Schedule' : 'New Schedule'}
        icon="clock"
        intro="It runs your agent in this chat, on its own. Deleting the chat deletes the schedule."
        submitLabel={id ? 'Save' : 'Create Schedule'}
        canSubmit={!problem}
        onSubmit={submit}
        onCancel={cancel}
        width={660}
        footer={
          id ? (
            <Button type="button" variant="quiet" tone="error" onClick={() => setAsking('remove')}>
              Remove
            </Button>
          ) : undefined
        }
      >
        <Field label="Name" htmlFor="schedule-name">
          <TextInput id="schedule-name" value={draft.title} maxLength={80} placeholder="Morning check" onChange={(title) => set({ title })} />
        </Field>
        <Field label="Prompt" htmlFor="schedule-prompt">
          <TextArea id="schedule-prompt" value={draft.prompt} rows={4} maxLength={8000} placeholder="What should the agent do each time?" onChange={(prompt) => set({ prompt })} />
        </Field>
        <Field label="When">
          <div className={c.when}>
            <Segmented label="Kind of schedule" value={draft.whenKind} options={WHEN_KINDS} onChange={(whenKind) => set({ whenKind })} />
            {draft.whenKind === 'schedule' ? <ScheduleControls hideMissed value={draft.trigger} onChange={(trigger) => set({ trigger })} /> : null}
            {draft.whenKind === 'interval' ? (
              <label className={c.inline}>
                Every
                <TextInput className={c.minutes} aria-label="Minutes" inputMode="numeric" value={draft.minutes} onChange={(minutes) => set({ minutes })} />
                minutes, counted from the end of the last run
              </label>
            ) : null}
            {draft.whenKind === 'once' ? <TextInput aria-label="Date and time" type="datetime-local" value={draft.onceAt} onChange={(onceAt) => set({ onceAt })} /> : null}
          </div>
        </Field>
        {draft.whenKind === 'once' ? null : (
          <Field label="If this computer was off">
            <Popup label="If this computer was off" value={draft.missed} options={MISSED} onChange={(missed) => set({ missed })} />
          </Field>
        )}
        <Field label="If the agent is busy">
          <Popup label="If the agent is busy" value={draft.ifBusy} options={IF_BUSY} onChange={(ifBusy) => set({ ifBusy })} />
        </Field>
        <Field label="Each run">
          <Popup label="Each run" value={draft.context} options={EACH_RUN} onChange={(context) => set({ context })} />
        </Field>
        <div className={c.where}>Runs on this {computerWord()} · in this chat</div>
      </FormSheet>
      {asking === 'discard' ? <Alert title="Discard your changes?" message="This schedule stays as it was." tone="caution" confirm={{ label: 'Discard', destructive: true, onClick: close }} cancel="Keep Editing" onCancel={() => setAsking(undefined)} /> : null}
      {asking === 'remove' && id ? (
        <Alert
          title={`Remove “${draft.title.trim() || saved?.title || 'this schedule'}”?`}
          message="It stops running in this chat. A run under way finishes. You can’t undo this."
          tone="danger"
          confirm={{ label: 'Remove', destructive: true, onClick: remove }}
          onCancel={() => setAsking(undefined)}
        />
      ) : null}
    </>
  );
}
