import { mkdirSync, promises as fs, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentPlace, MacTools } from '../../agent/types.js';
import { ASSISTANT_CHANNEL, ASSISTANT_TITLE } from '../../shared/assistant.js';
import { SCRATCH_DIR, listScratch } from '../../workspaces/scratch.js';
import { type SystemPort, captureScreen, describeDevice, deviceInfo, realSystem } from '../gateway/device.js';
import { HistorySaver } from '../history-saver.js';
import { tilde } from '../paths.js';
import { planTitle } from '../plans/model.js';
import { busyChannels } from '../board/work.js';
import { type LogItem, type Store, settleRun } from '../store.js';
import type { Workspace } from '../../workspaces/types.js';

/**
 * "Your Mac" (BLG-47, docs/companion.md): one conversation with your own Claude that isn't tied to
 * a project or a worktree. You talk to it from the phone (the Ask sheet's first target, Home's "Ask
 * your Mac") and from the Mac (the sidebar's top row): "take a screenshot and send it to me",
 * "what's using my CPU?", "start a worktree in beluga for the login bug".
 *
 * Where it lives: ~/.beluga/assistant/. Its Claude works in `work/` (its scratch folder is
 * `work/.beluga/scratch/`, where screenshots and files it sends you go); its Claude session and
 * its history are beside it (`state.json`, `history.json`). Everything in Beluga's home is secret
 * to the phone (isSecretPath) except a few folders Claude works in; `assistant/work` is one of
 * them now, exactly as `tasks/work` (friends' tasks' scratch folders) is, and nothing beside it:
 * the session id and the history stay secret.
 *
 * Its Claude is yours: your approvals as anywhere else (commands ask unless you said never), its
 * edits only in its own folder. Its tools (agent/mac-tools.ts) look at this Mac and start work.
 */

export interface AssistantDeps {
  readonly store: Store;
  /** ~/.beluga/assistant (a temporary folder in the demo and the tests). */
  readonly dir: string;
  readonly selfId: () => string;
  /** The screen and the device (a pretend Mac in the demo and the tests). */
  readonly system?: SystemPort;
  /** Starting work: a worktree with its Claude on a message (workspace-controller's startWorktree). */
  readonly startWorktree?: (projectId: string, message: string, opts: { readonly name?: string; readonly plan?: boolean }) => Promise<Workspace | undefined>;
  /** A board task started in its own worktree with Claude (board's start) → the worktree's id. */
  readonly startTask?: (key: string) => Promise<string>;
  /** A plan drafted in its own conversation (plans' create) → its id. */
  readonly startPlan?: (projectId: string, goal: string) => Promise<{ readonly id: string }>;
}

interface Saved {
  readonly sessionId?: string;
}

/** The most items kept of its history (as a worktree's). */
const KEEP = 500;

export class MacAssistant {
  readonly channel = ASSISTANT_CHANNEL;
  /** Where its Claude works. */
  readonly workDir: string;
  private saved: Saved;
  private readonly saver: HistorySaver;
  private readonly unsubscribe: () => void;
  private lastLog: readonly LogItem[] | undefined;

  constructor(private readonly deps: AssistantDeps) {
    this.workDir = path.join(deps.dir, 'work');
    mkdirSync(this.workDir, { recursive: true, mode: 0o700 });
    this.saved = readJson<Saved>(this.file('state.json'), {});
    this.saver = new HistorySaver({
      log: () => deps.store.getState().log,
      channels: () => new Set([ASSISTANT_CHANNEL]),
      idOf: (channel) => (channel === ASSISTANT_CHANNEL ? 'assistant' : undefined),
      write: async (_id, items, current) => {
        const file = this.file('history.json');
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, `${JSON.stringify(items)}\n`, { mode: 0o600 });
        if (current()) renameSync(tmp, file);
        else await fs.rm(tmp, { force: true });
      },
      writeSync: (_id, items) => writeJson(this.file('history.json'), items),
      keep: KEEP,
    });
    this.load();
    this.lastLog = deps.store.getState().log;
    this.unsubscribe = deps.store.subscribe(() => {
      const log = deps.store.getState().log;
      if (log === this.lastLog) return;
      this.lastLog = log;
      this.saver.changed();
    });
  }

  stop(): void {
    this.unsubscribe();
    this.saver.stop();
  }

  private file(name: string): string {
    return path.join(this.deps.dir, name);
  }

  /** What was said here before (a run cut off by a quit reads as interrupted), with anything said since. */
  private load(): void {
    const saved = readJson<LogItem[]>(this.file('history.json'), []);
    const live = this.deps.store.getState().log.filter((l) => l.channel === ASSISTANT_CHANNEL);
    const known = new Set(saved.map((l) => l.id));
    if (saved.length || live.length) this.deps.store.dispatch({ type: 'history', channel: ASSISTANT_CHANNEL, items: [...saved.map(settleRun), ...live.filter((l) => !known.has(l.id))] });
    this.saver.loaded(ASSISTANT_CHANNEL);
  }

  /** Where its Claude runs: its own folder, its own resumable session. */
  place(): AgentPlace {
    return {
      cwd: this.workDir,
      additionalDirectories: [],
      // Its own folder only: files it makes there (a screenshot, a report to send) need no approval.
      autoEdit: true,
      ...(this.saved.sessionId ? { resume: this.saved.sessionId } : {}),
      onSession: (sessionId) => {
        if (sessionId === this.saved.sessionId) return;
        this.saved = { ...this.saved, sessionId };
        writeJson(this.file('state.json'), this.saved);
      },
    };
  }

  /** Starting over (Clear chat, fresh): a new Claude conversation next time. */
  forget(): void {
    this.saved = {};
    writeJson(this.file('state.json'), this.saved);
  }

  /** What a run here gets: your runs only (nobody else can write in it). */
  forRun(channel: string, from: string): { readonly place: AgentPlace; readonly tools: MacTools; readonly brief: string } | undefined {
    if (channel !== ASSISTANT_CHANNEL || from !== this.deps.selfId()) return undefined;
    return { place: this.place(), tools: this.tools(), brief: assistantBrief() };
  }

  /** Its outputs (what's in its scratch folder), newest first: what the phone shows with it. */
  async outputs(): Promise<Array<{ path: string; size: number; ts: number; cwd: string }>> {
    const files = await listScratch(this.workDir).catch(() => []);
    return files.map((f) => ({ path: path.join(this.workDir, f.path), size: f.size, ts: f.mtime, cwd: this.workDir })).sort((a, b) => b.ts - a.ts);
  }

  private project(name: string): { id: string; name: string } {
    const want = name.trim().toLowerCase();
    const projects = this.deps.store.getState().projects.filter((p) => p.root);
    const p = projects.find((x) => x.name.toLowerCase() === want || x.id === name) ?? projects.find((x) => x.name.toLowerCase().includes(want));
    if (!p) throw new Error(`There's no project called ${name} here. Projects: ${projects.map((x) => x.name).join(', ') || 'none yet'}`);
    return p;
  }

  tools(): MacTools {
    const sys = this.deps.system ?? realSystem;
    return {
      screenshot: async (app) => {
        const shot = await captureScreen(sys, path.join(this.workDir, SCRATCH_DIR, 'screens'), app ? { app } : {});
        // Claude sees the smaller copy; only the picture itself stays (one output per screenshot).
        const view = shot.view ? await fs.readFile(shot.view) : undefined;
        if (shot.view && shot.view !== shot.file) await fs.rm(shot.view, { force: true });
        const rel = path.relative(this.workDir, shot.file);
        return {
          text: `Screenshot of ${shot.of} (${Math.round(shot.bytes / 1024)} KB), saved as ${rel}: it shows as an output on the owner's phone and Mac with your answer. Say what it shows in a line; don't describe the path.`,
          ...(view ? { image: { data: view.toString('base64'), mimeType: shot.view?.endsWith('.png') ? 'image/png' : 'image/jpeg' } } : {}),
        };
      },
      deviceInfo: async () => {
        const info = await deviceInfo(sys);
        return `${describeDevice(info)}\n\nAs JSON:\n${JSON.stringify(info, null, 2)}`;
      },
      listWork: () => listWork(this.deps.store),
      startWorktree: async ({ project, message, name, plan }) => {
        if (!this.deps.startWorktree) throw new Error('Worktrees need the Beluga app');
        const p = this.project(project);
        const ws = await this.deps.startWorktree(p.id, message, { ...(name ? { name } : {}), ...(plan ? { plan: true } : {}) });
        if (!ws) throw new Error(`Couldn't create the worktree in ${p.name} (Beluga showed the owner why)`);
        return `Started the worktree "${ws.name}" in ${p.name} (branch ${ws.branch ?? ws.name}, from ${ws.base ?? 'the latest origin'}); its Claude is ${plan ? 'planning it first' : 'working on it now'}. Name it in your answer as \`worktree:${ws.id}\` (a link on both screens).`;
      },
      startTask: async (key) => {
        if (!this.deps.startTask) throw new Error('Tasks need the Beluga app');
        const wsId = await this.deps.startTask(key);
        const ws = this.deps.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === wsId);
        return `Started ${key.toUpperCase()} in the worktree "${ws?.name ?? wsId}", with Claude carrying it through. Name both in your answer: \`task:${key.toUpperCase()}\` and \`worktree:${wsId}\`.`;
      },
      startPlan: async ({ project, goal }) => {
        if (!this.deps.startPlan) throw new Error('Plans need the Beluga app');
        const p = this.project(project);
        const plan = await this.deps.startPlan(p.id, goal);
        return `Started a plan in ${p.name}: its Claude is drafting the milestones and tasks for the owner to approve. Name it in your answer as \`plan:${plan.id}\`.`;
      },
    };
  }
}

/** What Claude is told it is, here. */
export function assistantBrief(): string {
  return [
    '',
    '',
    `You are "${ASSISTANT_TITLE}": the owner's assistant for this Mac as a whole, not one project. They talk to you`,
    'from their phone or from the Mac (this conversation is the same on both), often away from the Mac, so answer',
    'short and in plain words, and send back what they asked for rather than describing it.',
    '',
    'Your tools (mcp__beluga_mac__*):',
    '- screenshot: the main display or one app’s window. It is saved in your scratch folder, so it reaches the',
    '  owner as an output with your answer. "Send me a screenshot" is this.',
    '- device_info: the Mac’s model, macOS, memory, disk, battery, network, apps. For what is using the CPU or',
    '  memory right now, run a read-only command (`ps -Ao pid,pcpu,pmem,comm -r | head -15`, `top -l 1 -n 10`).',
    '- list_work: the projects, their worktrees and chats (ids), what Claude is working on, the plans. Check it',
    '  before starting anything, and to answer "what\'s running?".',
    '- start_worktree: a new worktree in a project with its own Claude on a first message you write as a complete,',
    '  self-contained task. Do not do project work yourself here: start a worktree for it.',
    '- The board (mcp__beluga_board__*): task_create (name the project), task_update, task_list…; start_task',
    '  starts one in its own worktree. start_plan: a plan in a project, drafted by its own Claude for approval.',
    '- Commands (Bash) run on this Mac with the owner’s usual approvals.',
    '',
    'Files the owner should get (a report, a log, a CSV, an image): write them into your scratch folder; each one',
    'shows as an output on their phone. Never put secrets there.',
    '',
    'What you start, name in your answer exactly as the tool said, in backticks, so both screens draw a link:',
    '`worktree:<id>`, `task:<KEY>`, `plan:<id>`. Never invent an id.',
  ].join('\n');
}

/** Projects, their worktrees and chats, what's running, plans: what list_work says. */
export function listWork(store: Store): string {
  const state = store.getState();
  const busy = busyChannels(state.log);
  const lines: string[] = [];
  const projects = state.projects.filter((p) => p.root);
  if (!projects.length) lines.push('No projects yet (the owner adds them in Beluga on the Mac).');
  for (const p of projects) {
    lines.push(`${p.name} · ${tilde(p.root)} · default branch ${p.base}`);
    const shown = p.workspaces.filter((w) => !w.archived && !w.pending && w.kind !== 'main');
    for (const w of shown.slice(0, 40)) lines.push(`  - ${w.kind} "${w.name}" · id ${w.id}${w.branch && w.kind === 'worktree' ? ` · branch ${w.branch}` : ''}${busy.has(`ws:${w.id}`) ? ' · Claude working' : ''}`);
    if (shown.length > 40) lines.push(`  - and ${shown.length - 40} more`);
  }
  const chats = state.projects.find((p) => !p.root)?.workspaces.filter((w) => !w.archived) ?? [];
  if (chats.length) lines.push(`Chats (no project): ${chats.slice(0, 20).map((w) => `"${w.name}"${busy.has(`ws:${w.id}`) ? ' (Claude working)' : ''}`).join(', ')}`);
  const plans = state.plans.plans.filter((p) => p.status !== 'done');
  if (plans.length) lines.push('', 'Plans:', ...plans.slice(0, 20).map((p) => `  - "${planTitle(p)}" · id ${p.id} · ${p.status}${p.paused ? ', paused' : ''}`));
  const running = [...busy].filter((c) => c.startsWith('ws:')).length;
  lines.push('', running ? `${running} conversation${running === 1 ? '' : 's'} with Claude working now.` : 'Nothing is running right now.');
  return lines.join('\n');
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
