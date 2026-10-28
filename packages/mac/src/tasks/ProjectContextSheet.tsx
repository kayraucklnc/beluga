import { useState } from 'react';
import { MAX_PROJECT_CONTEXT } from '@beluga/core/board/model.js';
import { Field, FormSheet, TextArea } from '../components/FormSheet.js';
import { toast, useApp, useBeluga } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { ago } from './tasks-model.js';
import { useBoard, useTaskActions } from './use-tasks.js';

const PLACEHOLDER = [
  'What the app is and who it’s for.',
  'How the code is laid out: the main parts and where they live.',
  'Words the team uses, and anything a new person gets wrong.',
].join('\n');

/**
 * About This Project (BLG-298): a few paragraphs Claude reads whenever it writes a task here, so a
 * task makes sense without a look at the whole codebase. Teammates on the project share it.
 */
export function ProjectContextSheet({ projectId, close }: { projectId: string; close: () => void }) {
  const board = useBoard();
  const { client } = useBeluga();
  const { api } = useTaskActions();
  const mates = useApp((st) => st.team.teams[projectId]?.mates.map((m) => m.name) ?? [], sameDeep);
  const saved = board.projects[projectId]?.context;
  const [text, setText] = useState(saved?.text ?? '');
  const changed = text.trim() !== (saved?.text ?? '');
  const shared = mates.length ? `Shared with ${mates.join(', ')}: an edit here reaches them too.` : 'Teammates on this project get it too.';
  return (
    <FormSheet
      title="About This Project"
      icon="book"
      intro="Claude reads this whenever it writes a task here, so tasks use the project’s own words and point at the right part of the app."
      submitLabel="Save"
      width={600}
      canSubmit={changed}
      onCancel={close}
      onSubmit={async () => {
        await api.setContext(projectId, text);
        close();
        toast(client, text.trim() ? 'Claude knows about this project now' : 'The project’s context is cleared', 'success');
      }}
    >
      <Field label="Context" htmlFor="project-context" hint={`${shared}${saved?.text ? ` Last edited by ${saved.by}, ${ago(saved.at)}.` : ''}`}>
        <TextArea id="project-context" autoFocus rows={12} value={text} placeholder={PLACEHOLDER} maxLength={MAX_PROJECT_CONTEXT} onChange={setText} />
      </Field>
    </FormSheet>
  );
}
