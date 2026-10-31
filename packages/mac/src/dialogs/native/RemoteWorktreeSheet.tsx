import { useState } from 'react';
import { Checkbox, Field, FormSheet, Popup, TextArea } from '../../components/FormSheet.js';
import { defaultAgentOf } from '@beluga/protocol.js';
import { agentName } from '@beluga/shared/agent-label.js';
import { useApi, useApp } from '../../lib/beluga.js';
import type { NativeMenuProps } from './index.js';

/**
 * Start a worktree on a friend's computer: which of their projects, the task, and whether their
 * Claude plans first. They approve it, then their Claude does the work there.
 */
export function RemoteWorktreeForm({ peerId, project, close }: { peerId: string; project?: string; close: () => void }) {
  const api = useApi();
  const peer = useApp((st) => st.peers.find((p) => p.peerId === peerId));
  const planDefault = useApp((st) => st.planMode.room === true);
  const projects = peer?.projects ?? [];
  const [picked, setPicked] = useState(project ?? projects[0] ?? '');
  const [task, setTask] = useState('');
  const [plan, setPlan] = useState(planDefault);
  if (!peer) return null;
  return (
    <FormSheet
      title={`New Worktree on ${peer.name}’s Computer`}
      icon="branch"
      intro={`${peer.name} approves it, then ${peer.name}’s ${agentName(defaultAgentOf(peer))} does the work there. You both see it in the sidebar.`}
      submitLabel={`Ask ${peer.name}`}
      canSubmit={Boolean(picked && task.trim())}
      onSubmit={() => {
        void api.remote.requestWorktree(peer.peerId, picked, task.trim(), plan);
        close();
      }}
      onCancel={close}
      width={540}
    >
      <Field label="Project" htmlFor="rws-project">
        <Popup id="rws-project" label="Project" value={picked} onChange={setPicked} options={projects.map((p) => ({ value: p, label: p }))} />
      </Field>
      <Field label="Task" htmlFor="rws-task" hint={`What their ${agentName(defaultAgentOf(peer))} should do. ⌘Return asks.`}>
        <TextArea id="rws-task" value={task} onChange={setTask} rows={4} placeholder="Add a health check endpoint and a test for it" data-autofocus />
      </Field>
      <Field label="">
        <Checkbox checked={plan} onChange={setPlan} label="Plan first" detail={`${peer.name}’s ${agentName(defaultAgentOf(peer))} shows a plan before changing anything`} />
      </Field>
    </FormSheet>
  );
}

export function RemoteWorktreeSheet({ menu, close }: NativeMenuProps<'remote_ws'>) {
  return <RemoteWorktreeForm peerId={menu.peerId} close={close} />;
}
