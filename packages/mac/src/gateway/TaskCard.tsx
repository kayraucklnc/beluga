import { memo, useState } from 'react';
import { type TaskView, approvalTitle, isFinal, stateLabel, stateTone, targetLabel } from '@klaud/core/gateway/model.js';
import { formatDuration } from '@klaud/shared/text.js';
import { Markdown } from '../chat/Markdown.js';
import { useNow } from '../chat/Items.js';
import { Icon } from '../components/Icon.js';
import { Avatar, Button, Dot } from '../components/ui.js';
import { revealInFinder } from '../lib/files.js';
import { useApi, useApp, useKlaud } from '../lib/klaud.js';
import s from './gateway.module.css';

/**
 * One task between Claudes, as a card: in the conversation your Claude asked from (sent →
 * waiting for Alice → working, with steps → the result with its summary, data and files), and
 * in Requests. While your Claude waits for your OK to ask someone you don't trust yet, the card
 * asks you: Ask / Edit / Not now.
 */

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function useCall(): (what: string, call: Promise<unknown>) => void {
  const { client } = useKlaud();
  return (what, call) => void call.catch((err: unknown) => client.store.dispatch({ type: 'toast', text: `Couldn't ${what}: ${message(err)}`, level: 'error' }));
}

/** Structured data as a table when it has the shape of one, else as JSON. */
export function DataTable({ data }: { data: unknown }) {
  const isRow = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const cell = (v: unknown): string => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  if (Array.isArray(data) && data.length && data.every(isRow)) {
    const cols = [...new Set(data.flatMap((r) => Object.keys(r)))].slice(0, 8);
    return (
      <table className={s.table} aria-label="Data">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.slice(0, 50).map((row, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} className="selectable">
                  {cell(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (isRow(data) && Object.keys(data).length <= 24) {
    return (
      <table className={s.table} aria-label="Data">
        <tbody>
          {Object.entries(data).map(([k, v]) => (
            <tr key={k}>
              <td className={s.key}>{k}</td>
              <td className={`${typeof v === 'object' && v !== null ? s.mono : ''} selectable`}>{cell(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return <pre className={`${s.json} selectable`}>{JSON.stringify(data, null, 2)}</pre>;
}

const kb = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function Result({ task }: { task: TaskView }) {
  const { client } = useKlaud();
  const r = task.result;
  if (!r) return null;
  return (
    <div className={s.result}>
      {r.summary ? <Markdown text={r.summary} /> : null}
      {r.data !== undefined ? (
        <>
          <span className={s.label}>Data</span>
          <DataTable data={r.data} />
        </>
      ) : null}
      {r.files.length ? (
        <>
          <span className={s.label}>Files</span>
          <div className={s.files}>
            {r.files.map((f) => (
              <div key={f.name} className={s.file}>
                <Icon name="file" size={13} />
                {f.path ? (
                  <button type="button" onClick={() => void revealInFinder(client, f.path!)} title="Show in Finder">
                    {f.name}
                  </button>
                ) : (
                  <span>{f.name}</span>
                )}
                <span className={s.via}>{f.path ? kb(f.size) : 'too big to come with the result'}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
      {r.problems?.length ? <div className={s.problems}>{r.valid === false ? 'The data doesn’t match what was asked for: ' : ''}{r.problems.join(' · ')}</div> : null}
    </div>
  );
}

/** A friend's request waiting for you: the same answers as the approval card above the message box. */
function Approve({ task }: { task: TaskView }) {
  const api = useApi();
  const call = useCall();
  const approval = useApp((st) => st.approvals.find((a) => a.title === approvalTitle(task)));
  if (!approval) return <div className={s.hint}>Waiting for your answer above the message box.</div>;
  return (
    <div className={s.actions}>
      <Button variant="primary" onClick={() => call('approve it', api.host.answerApproval('yes', approval.id))}>
        Approve
      </Button>
      <Button onClick={() => call('approve it', api.host.answerApproval('always', approval.id))}>Always allow from {task.peerName}</Button>
      <Button variant="quiet" onClick={() => call('decline it', api.host.answerApproval('no', approval.id))}>
        Decline
      </Button>
    </div>
  );
}

/** "Ask bob's Claude?" — your Claude waits for you. */
function Confirm({ task }: { task: TaskView }) {
  const api = useApi();
  const call = useCall();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(task.ask);
  return (
    <>
      {editing ? <textarea className={s.edit} aria-label="What to ask" value={text} onChange={(e) => setText(e.target.value)} autoFocus /> : <div className={`${s.ask} selectable`}>{task.ask}</div>}
      <div className={s.hint}>Your Claude wants to send this. You haven’t marked {task.peerName} as trusted, so it asks you first.</div>
      <div className={s.actions}>
        <Button variant="primary" onClick={() => call('send it', api.gateway.confirm(task.id, true, editing && text.trim() !== task.ask ? text : undefined))}>
          Ask {task.peerName}
        </Button>
        {editing ? null : (
          <Button icon="pencil" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
        <Button variant="quiet" onClick={() => call('answer', api.gateway.confirm(task.id, false))}>
          Not now
        </Button>
      </div>
    </>
  );
}

/** A task card placed in a conversation, lined up with the messages. */
export function LogTaskCard({ task }: { task: TaskView }) {
  return (
    <div className={s.inLog}>
      <TaskCard task={task} />
    </div>
  );
}

export const TaskCard = memo(function TaskCard({ task }: { task: TaskView }) {
  const api = useApi();
  const call = useCall();
  const live = !isFinal(task.state) && task.state !== 'confirm';
  const now = useNow(task.state === 'working');
  const tone = stateTone(task);
  const sent = task.direction === 'sent';
  const working = task.state === 'working' && task.startedAt ? ` · ${formatDuration(now - task.startedAt)}` : '';
  const done = isFinal(task.state) && task.endedAt ? ` · ${formatDuration(task.endedAt - task.createdAt)}` : '';
  const title = task.state === 'confirm' ? `Ask ${targetLabel(task)}?` : sent ? `To ${targetLabel(task)}` : `From ${task.peerName}${task.by === 'agent' ? '’s Claude' : ''}`;
  return (
    <section className={`${s.card} ${task.state === 'confirm' ? s.confirm : ''}`} aria-label={`Task: ${title}`} data-task={task.id} data-state={task.state}>
      <div className={s.head}>
        <Avatar name={task.peerName} id={task.peerId} claude={task.kind === 'ask'} size={20} />
        <span className={s.who}>{title}</span>
        {sent && task.by === 'agent' && task.state !== 'confirm' ? <span className={s.via}>asked by your Claude</span> : null}
        {!sent && task.where ? <span className={s.via}>{task.where}</span> : null}
        <span className={`${s.status} ${s[`tone_${tone}`]}`} role="status">
          {task.state === 'confirm' ? null : <Dot tone={tone === 'claude' ? 'claude' : tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : tone === 'error' ? 'error' : 'muted'} live={live} />}
          {stateLabel(task)}
          {working || done}
        </span>
      </div>
      {task.state === 'confirm' ? (
        <Confirm task={task} />
      ) : (
        <>
          {task.kind === 'run' && task.command ? <div className={`${s.command} selectable`}>$ {task.command}</div> : <div className={`${s.ask} selectable`}>{task.ask}</div>}
          {live && task.steps.length ? (
            <div className={s.steps} aria-label="Steps">
              {task.steps.slice(-4).map((step, i) => (
                <div key={i} className={s.step}>
                  <Icon name="chevronRight" size={10} />
                  <span>{step}</span>
                </div>
              ))}
            </div>
          ) : null}
          <Result task={task} />
          {!sent && task.state === 'awaiting_approval' ? <Approve task={task} /> : null}
          {live && !(!sent && task.state === 'awaiting_approval') ? (
            <div className={s.actions}>
              <Button size="small" variant="quiet" icon="stop" onClick={() => call(sent ? 'cancel it' : 'stop it', api.gateway.cancel(task.id))}>
                {sent ? 'Cancel' : 'Stop'}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
});
