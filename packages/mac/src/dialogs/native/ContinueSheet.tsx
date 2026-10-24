import { useEffect, useState } from 'react';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { Field, FormSheet, Popup, TextArea, TextInput } from '../../components/FormSheet.js';
import { useApi, useApp } from '../../lib/beluga.js';

/**
 * Continue a questions-only chat (a project's main folder) in a new worktree: what Claude should
 * do there (what you asked last, to start with), the branch it starts from, an optional name.
 * The conversation comes along; Claude starts right away.
 */
export function ContinueSheet({ wsId, close }: { wsId: string; close: () => void }) {
  const api = useApi();
  const ws = useApp((st) => findWorkspace(st.projects, wsId));
  const project = useApp((st) => st.projects.find((p) => p.workspaces.some((w) => w.id === wsId)));
  const asked = useApp((st) => {
    const mine = st.log.filter((l) => l.channel === `ws:${wsId}` && l.type === 'chat' && l.from === st.selfId);
    const last = mine[mine.length - 1];
    return last?.type === 'chat' ? last.text : '';
  });
  const [task, setTask] = useState(asked);
  const [name, setName] = useState('');
  const [branches, setBranches] = useState<{ base: string; branches: readonly string[] }>();
  const [base, setBase] = useState('');
  useEffect(() => {
    if (!project?.id) return;
    let alive = true;
    api.workspaces.branches(project.id).then(
      (b) => alive && b && (setBranches(b), setBase((cur) => cur || b.base)),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [project?.id]);
  if (!ws || !project) return null;
  const chosen = base || project.base;
  const options = (branches?.branches.length ? branches.branches : [chosen]).map((b) => ({ value: b, label: b === branches?.base ? `${b} (default)` : b }));
  return (
    <FormSheet
      title="Continue in a New Worktree"
      icon="branch"
      intro="This chat becomes a worktree: Claude gets its own branch and folder, keeps the conversation and starts on the task."
      submitLabel="Continue"
      onSubmit={async () => {
        await api.workspaces.continueInWorktree(ws.id, { ...(task.trim() ? { task: task.trim() } : {}), ...(chosen !== project.base ? { base: chosen } : {}), ...(name.trim() ? { name: name.trim() } : {}) });
        close();
      }}
      onCancel={close}
      width={540}
    >
      <Field label="Task" htmlFor="continue-task" hint="Empty: Claude goes ahead with what you discussed. ⌘Return continues.">
        <TextArea id="continue-task" value={task} onChange={setTask} rows={4} placeholder="What should Claude change?" data-autofocus />
      </Field>
      <Field label="Based on" htmlFor="continue-base" hint="Origin branches are fetched first, so it starts from the latest.">
        <Popup id="continue-base" label="Based on" value={chosen} options={options} onChange={setBase} />
      </Field>
      <Field label="Name" htmlFor="continue-name" hint="Empty: named after the task.">
        <TextInput id="continue-name" value={name} onChange={setName} maxLength={60} placeholder="from the task" spellCheck={false} />
      </Field>
    </FormSheet>
  );
}
