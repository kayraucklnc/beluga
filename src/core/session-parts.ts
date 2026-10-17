import type { SessionOptions, Session } from './session.js';
import type { ModelChoice } from './work-store.js';
import { WorkspaceController } from './workspace-controller.js';
import { Notifier } from './notify.js';
import { Workbench } from './workbench.js';
import { QuestionBroker } from './questions.js';
import { WorkspaceSharing } from './workspace-sharing.js';
import { ReplayGuard } from './replay.js';
import { People } from './people.js';
import { RoomFiles } from './room-files.js';
import { AgentHost } from './agent-host.js';
import { RemoteWork } from './remote-work.js';

/** Everything a session is made of, wired to each other and to the session. */
export interface SessionParts {
  readonly workspaces?: WorkspaceController;
  readonly notifier: Notifier;
  readonly workbench?: Workbench;
  readonly questions: QuestionBroker;
  readonly sharing: WorkspaceSharing;
  readonly replay: ReplayGuard;
  readonly people: People;
  readonly files: RoomFiles;
  readonly host: AgentHost;
  readonly remote: RemoteWork;
}

export function createSessionParts(session: Session, opts: SessionOptions): SessionParts {
  let workspaces: WorkspaceController | undefined;
  let workbench: Workbench | undefined;
    if (opts.workspaces) {
      workspaces = new WorkspaceController({
        manager: opts.workspaces,
        store: opts.store,
        shares: opts.shares,
        selfId: () => session.selfId,
        toast: (text, level) => session.toast(text, level),
        askClaude: (prompt, channel) => session.askOwnClaude(prompt, channel),
        findConversation: opts.findConversation ? (dir) => opts.findConversation!(dir, { id: session.selfId, name: session.store.getState().self?.name ?? 'you' }) : undefined,
        onWorktreeCreated: (ws) => workbench?.onWorktreeCreated(ws),
      });
    }
    const notifier = new Notifier({ store: opts.store, desktop: (n) => opts.desktopNotify?.(n) });
    if (workspaces) {
      workbench = new Workbench({
        store: opts.store,
        controller: workspaces,
        terminals: opts.terminals,
        notify: (e) => notifier.notify(e),
        toast: (text, level) => session.toast(text, level),
        askClaude: (prompt, channel) => session.askOwnClaude(prompt, channel),
        setPrefs: (prefs) => session.setPrefs(prefs),
        confirm: (title, detail) => session.ask('request', title, detail),
        open: opts.open,
        listModels: async () => (await session.backend?.listModels?.()) as readonly ModelChoice[] | undefined,
        findPr: opts.findPr,
        hasGh: opts.hasGh,
      });
    }
    const questions = new QuestionBroker({
      store: opts.store,
      selfId: () => session.selfId,
      send: (body, o) => session.send(body, o),
      timeoutMs: () => session.approvalTimeoutMs,
      toast: (text, level) => session.toast(text, level),
    });
    const sharing = new WorkspaceSharing({
      store: opts.store,
      selfId: () => session.selfId,
      send: (body, o) => session.send(body, o),
      shares: opts.shares,
      workspaces: opts.workspaces,
      toast: (text, level) => session.toast(text, level),
    });
    const replay = new ReplayGuard(opts.replayFile);
    const people = new People({
      store: opts.store,
      selfId: () => session.selfId,
      saved: opts.savedPeople ?? {},
      save: (people) => opts.saveSettings?.({ people }),
      toast: (text, level) => session.toast(text, level),
    });
    const files = new RoomFiles({
      store: opts.store,
      selfId: () => session.selfId,
      send: (body, o) => session.send(body, o),
      shares: opts.shares,
      toast: (text, level) => session.toast(text, level),
      system: (text, level) => session.system(text, level),
      requestTimeoutMs: opts.requestTimeoutMs,
      downloadDir: opts.downloadDir,
    });
    const host = new AgentHost({
      store: opts.store,
      selfId: () => session.selfId,
      send: (body, o) => session.send(body, o),
      agent: () => session.backend,
      shares: opts.shares,
      sharing,
      people,
      questions,
      workspaces,
      toast: (text, level) => session.toast(text, level),
      system: (text, level) => session.system(text, level),
      approvalTimeoutMs: () => session.approvalTimeoutMs,
      refreshUsage: () => session.refreshUsage(),
    });
    const remote = new RemoteWork({
      store: opts.store,
      selfId: () => session.selfId,
      send: (body, o) => session.send(body, o),
      request: (to, b) => files.request(to, b),
      shares: opts.shares,
      controller: workspaces,
      sharing,
      approve: (title, detail, peer) => session.ask('request', title, detail, peer).then((a) => a !== 'no'),
      runOnBehalf: (from, channel, prompt) => session.runOnBehalf(from, channel, prompt),
      runFor: (from, channel, prompt, plan) => session.runFor(from, channel, prompt, plan),
      askAndWait: (prompt, channel, timeoutMs) => session.askAndWait(prompt, channel, timeoutMs),
      askOwnClaude: (prompt, channel) => session.askOwnClaude(prompt, channel),
      nameTask: (prompt) => session.nameTask(prompt),
      notify: (e) => notifier.notify(e),
      toast: (text, level) => session.toast(text, level),
      onWorktreeCreated: (ws) => workbench?.onWorktreeCreated(ws),
      downloadDir: opts.downloadDir,
    });
  return { workspaces, notifier, workbench, questions, sharing, replay, people, files, host, remote };
}
