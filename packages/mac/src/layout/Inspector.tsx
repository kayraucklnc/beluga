import type { ReactNode } from 'react';
import { findWorkspace, stateOf } from '@klaud/ui/workspace-models.js';
import { formatTokens } from '@klaud/ui/work-models.js';
import { formatBytes } from '@klaud/shared/format.js';
import { Icon } from '../components/Icon.js';
import { Avatar, Button, Dot } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApi, useApp, useKlaud } from '../lib/klaud.js';
import { openExternal } from '../lib/system.js';
import s from './Inspector.module.css';

function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className={s.panel}>
      <div className={s.panelHead}>
        <h3>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={s.field}>
      <span className={s.fieldLabel}>{label}</span>
      <span className={s.fieldValue}>{children}</span>
    </div>
  );
}

const ago = (ts: number): string => {
  const m = Math.round((Date.now() - ts) / 60_000);
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

/** Everything waiting on you, in one place, wherever you are. */
function NeedsYou() {
  const api = useApi();
  const actions = useActions();
  const state = useApp((st) => st);
  const { approvals, questions } = state;
  if (!approvals.length && !questions.length) return null;
  const place = (channel: string): string => {
    if (channel === 'room') return 'the chat';
    const id = channel.slice(3);
    return findWorkspace(state.projects, id)?.name ?? state.shared.find((w) => w.id === id)?.name ?? 'a workspace';
  };
  return (
    <Panel title="Needs you">
      {approvals.map((a) => (
        <div key={a.id} className={s.need}>
          <div className={s.needTitle}>
            <Dot tone="warn" />
            {a.title}
          </div>
          <div className={s.needActions}>
            <Button size="small" variant="primary" onClick={() => void api.host.answerApproval('yes', a.id)}>
              Allow
            </Button>
            <Button size="small" variant="quiet" onClick={() => void api.host.answerApproval('no', a.id)}>
              Deny
            </Button>
          </div>
        </div>
      ))}
      {questions.map((q) => (
        <button
          key={q.qid}
          type="button"
          className={s.needLink}
          onClick={() => {
            const id = q.channel.slice(3);
            const shared = state.shared.find((w) => w.id === id);
            if (q.channel === 'room') actions.run({ type: 'view', view: { kind: 'room' } });
            else if (shared) actions.run({ type: 'open_shared', owner: shared.owner, id, tab: 'chat' });
            else actions.run({ type: 'open_ws', id });
          }}
        >
          <Icon name={q.question.kind === 'plan' ? 'wand' : 'spark'} size={12} />
          {q.question.kind === 'plan' ? 'A plan to approve' : 'A question'} in {place(q.channel)}
          <Icon name="chevronRight" size={10} />
        </button>
      ))}
    </Panel>
  );
}

function WorkspaceDetails({ id }: { id: string }) {
  const api = useApi();
  const actions = useActions();
  const { ui } = useKlaud();
  const state = useApp((st) => st);
  const ws = findWorkspace(state.projects, id);
  if (!ws) return null;
  const st = stateOf(state, ws, 0);
  const pr = state.prs[ws.id];
  const ctx = state.context[`ws:${ws.id}`];
  const setup = state.setup[ws.id];
  const members = Object.entries(state.members[ws.id] ?? {});
  const tokens = ws.usage ? ws.usage.input + ws.usage.output + ws.usage.cacheWrite : 0;
  const project = state.projects.find((p) => p.id === ws.projectId);
  return (
    <>
      <Panel title="This workspace">
        <Field label="State">
          <span className={s[`tone_${st.tone}`]}>{st.label}</span>
        </Field>
        {ws.branch ? <Field label="Branch">{ws.branch}</Field> : null}
        {ws.base ? <Field label="From">{ws.base}</Field> : null}
        {ws.status ? (
          <Field label="Changes">
            {ws.status.changed} uncommitted · {ws.status.ahead} ahead{ws.status.behind ? ` · ${ws.status.behind} behind` : ''}
          </Field>
        ) : null}
        {ctx ? (
          <Field label="Context">
            <span className={s.meter}>
              <span style={{ width: `${Math.min(100, (ctx.used / ctx.window) * 100)}%` }} />
            </span>
            {Math.round((ctx.used / ctx.window) * 100)}%
          </Field>
        ) : null}
        {tokens ? <Field label="Claude">{`${formatTokens(tokens)} tokens${ws.usage?.cost ? ` · $${ws.usage.cost.toFixed(2)}` : ''}`}</Field> : null}
        {state.disk[ws.id] !== undefined ? <Field label="Disk">{formatBytes(state.disk[ws.id]!)}</Field> : null}
        {setup ? <Field label="Setup">{setup.status === 'running' ? 'Running…' : setup.status === 'done' ? 'Done' : `Failed${setup.detail ? ` (${setup.detail})` : ''}`}</Field> : null}
        {ws.handedTo ? <Field label="Handed to">{ws.handedTo}</Field> : null}
        {ws.handedFrom ? <Field label="From">{ws.handedFrom}</Field> : null}
        <div className={s.buttons}>
          <Button size="small" icon="folder" onClick={() => void api.workspaces.openInFinder(ws.id)}>
            Finder
          </Button>
          {project?.root ? (
            <Button size="small" icon="terminal" onClick={() => ui.openMenu({ kind: 'scripts', projectId: ws.projectId })}>
              Commands
            </Button>
          ) : null}
        </div>
      </Panel>
      {pr ? (
        <Panel title={`Pull request #${pr.number}`} action={<Button size="small" variant="quiet" icon="refresh" onClick={() => void api.workbench.refreshPrs(ws.id)} />}>
          <div className={s.prTitle}>{pr.title}</div>
          <Field label="Checks">
            <Dot tone={pr.checks === 'passing' ? 'ok' : pr.checks === 'failing' ? 'error' : pr.checks === 'pending' ? 'warn' : 'muted'} />
            {pr.checks}
          </Field>
          <Field label="State">{pr.state === 'OPEN' ? (pr.draft ? 'Draft' : 'Open') : pr.state === 'MERGED' ? 'Merged' : 'Closed'}</Field>
          {pr.review ? <Field label="Review">{pr.review === 'APPROVED' ? 'Approved' : pr.review === 'CHANGES_REQUESTED' ? 'Changes requested' : 'Waiting for review'}</Field> : null}
          <div className={s.buttons}>
            <Button size="small" onClick={() => void openExternal(pr.url)}>
              Open on GitHub
            </Button>
            {pr.checks === 'failing' ? (
              <Button size="small" variant="primary" onClick={() => void api.workbench.fixChecks(ws.id)}>
                Fix checks
              </Button>
            ) : null}
          </div>
        </Panel>
      ) : null}
      <Panel title="Working here" action={<Button size="small" variant="quiet" icon="plus" onClick={() => actions.run({ type: 'ws', id: ws.id, action: 'share' })} />}>
        {members.length ? (
          members.map(([peerId, role]) => {
            const name = state.peers.find((p) => p.peerId === peerId)?.name ?? 'someone';
            return (
              <div key={peerId} className={s.person}>
                <Avatar name={name} id={peerId} size={18} />
                <span className={s.personName}>{name}</span>
                <span className={s.dim}>{role === 'contribute' ? 'works here' : 'follows'}</span>
              </div>
            );
          })
        ) : (
          <div className={s.dim}>Only you. Share it to work on it together.</div>
        )}
      </Panel>
    </>
  );
}

function Room() {
  const state = useApp((st) => st);
  const hosting = state.hosting;
  return (
    <Panel title="Room">
      <Field label="Name">{state.room}</Field>
      <Field label="Status">{state.status === 'connected' ? 'Connected' : state.status === 'connecting' ? 'Connecting…' : 'Offline'}</Field>
      {state.isHost ? (
        <Field label="Invite">
          {hosting?.phase === 'ready' ? 'Ready to share' : hosting?.phase === 'local' ? 'Local network only' : hosting?.phase === 'failed' ? (hosting.detail ?? 'Couldn’t open remote access') : hosting ? 'Opening…' : 'Click Invite to open'}
        </Field>
      ) : null}
      {state.isHost ? <Field label="New people">{state.roomOpen ? 'Can join' : 'Closed'}</Field> : null}
    </Panel>
  );
}

function Inbox() {
  const api = useApi();
  const actions = useActions();
  const inbox = useApp((st) => st.inbox);
  const shared = useApp((st) => st.shared);
  const recent = inbox.slice(0, 6);
  if (!recent.length) return null;
  return (
    <Panel title="Inbox" action={inbox.some((n) => !n.read) ? <Button size="small" variant="quiet" onClick={() => void api.inbox.read()}>Mark read</Button> : undefined}>
      {recent.map((n) => (
        <button
          key={n.id}
          type="button"
          className={s.notice}
          onClick={() => {
            void api.inbox.read({ id: n.id });
            const ch = n.channel;
            if (!ch) return;
            if (ch === 'room') actions.run({ type: 'view', view: { kind: 'room' } });
            else {
              const id = ch.slice(3);
              const w = shared.find((x) => x.id === id);
              actions.run(w ? { type: 'open_shared', owner: w.owner, id, tab: 'chat' } : { type: 'open_ws', id });
            }
          }}
        >
          {n.read ? <span className={s.readDot} /> : <Dot tone={n.kind === 'problems' ? 'error' : n.kind === 'needsYou' ? 'warn' : 'info'} />}
          <span className={s.noticeText}>
            <span className={s.noticeTitle}>{n.title}</span>
            {n.body ? <span className={s.dim}>{n.body}</span> : null}
          </span>
          <span className={s.dim}>{ago(n.ts)}</span>
        </button>
      ))}
    </Panel>
  );
}

export function Inspector() {
  const view = useApp((st) => st.view);
  return (
    <aside className={s.inspector} aria-label="Inspector">
      <div className={s.titlebar} data-tauri-drag-region />
      <div className={s.scroll}>
        <NeedsYou />
        {view.kind === 'workspace' ? <WorkspaceDetails id={view.id} /> : <Room />}
        <Inbox />
      </div>
    </aside>
  );
}
