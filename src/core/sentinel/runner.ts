import { spawn } from 'node:child_process';
import os from 'node:os';
import { redactSecrets } from '../../shared/steps.js';
import type { NoticeEvent } from '../notify.js';
import type { RunFolders } from './files.js';
import { type ClaudeStep, type NotifyStep, type Run, type ScriptStep, type Sentinel, type Step, type StepRun, STEP_INFO, accessAllows, accessNeeded, ACCESS_INFO, firstLine, stepAvailable } from './model.js';
import { sentinelRunPrompt } from './prompt.js';
import { type RenderContext, dateText, render } from './render.js';

/**
 * A run's steps, one after the other (docs/sentinel.md §4, "Runner"): Ask Claude, Run a script,
 * Notify me. A step's output is text; the run stops when a script exits non-zero, Claude calls
 * sentinel_stop (skipped: nothing to do), the time limit is reached, or you stop it. Steps of later
 * phases are refused with a clear line. Everything it needs is injected, so the tests fake it.
 */

export interface ShellResult {
  readonly exitCode?: number;
  readonly output: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly ms: number;
}

export type SentinelShell = (command: string, cwd: string, timeoutMs: number, env: Record<string, string>, signal: AbortSignal) => Promise<ShellResult>;

export interface SentinelClaude {
  /** Ask your Claude in a conversation → the request's id (undefined: it can't be asked there). `shown`: what the chat shows you asked. */
  ask(prompt: string, channel: string, shown: string): string | undefined;
  /** That request's final message; rejects with what went wrong (an error, a denial). */
  wait(requestId: string): Promise<string>;
  /** Stop it (the run's time limit, or you stopped the run). */
  cancel(requestId: string, note: string): void;
}

export interface SentinelPlace {
  readonly channel: string;
  readonly workspaceId?: string;
}

export interface SentinelPlaces {
  /** A new quiet chat in the project's main folder (ask-only). */
  projectChat(projectId: string, title: string): Promise<SentinelPlace | undefined>;
  /** A new quiet worktree. */
  worktree(projectId: string, name: string): Promise<SentinelPlace | undefined>;
  /** A new chat in Your Mac. */
  macChat(): SentinelPlace | undefined;
  /** Whether a worktree has commits or changes of its own (undefined: can't tell, so it stays). */
  madeChanges(workspaceId: string): Promise<boolean | undefined>;
  /** Archive a worktree quietly (nothing of yours is lost). */
  archive(workspaceId: string): Promise<unknown>;
}

export interface RunnerDeps {
  readonly now: () => number;
  readonly claude?: SentinelClaude;
  readonly places?: SentinelPlaces;
  readonly shell: SentinelShell;
  /** Your variables for a command run there (Settings › Environment, the project's, its .env when on). */
  readonly envFor: (cwd: string) => Record<string, string>;
  readonly notify: (e: NoticeEvent) => void;
  readonly folders: RunFolders;
  readonly project: (id: string) => { readonly name: string; readonly root: string } | undefined;
  /** Beluga's own data for templates: open tasks, worktrees, plans (of a project, or all). */
  readonly beluga: (projectId: string | undefined) => { readonly tasks: string; readonly worktrees: string; readonly plans: string };
  readonly home: string;
  /** A turn among the Claude steps that may run together (Run at Once) → give it back when done. */
  readonly claudeTurn: (signal: AbortSignal) => Promise<() => void>;
}

/** A run going now: what the runner and Sentinels share about it. */
export interface ActiveRun {
  run: Run;
  readonly sentinel: Sentinel;
  readonly abort: AbortController;
  /** When its time limit is reached. */
  readonly deadline: number;
  /** The Claude step running now: its request, its conversation, and what Claude is told there. */
  claude?: { readonly stepId: string; readonly channel: string; readonly brief: string; requestId?: string };
  /** Claude said there's nothing to do (sentinel_stop). */
  stopReason?: string;
  /** Places made in this run, reused by its later steps. */
  places: Partial<Record<'project' | 'worktree' | 'mac', SentinelPlace>>;
}

/** Kept on the run and in the state; the whole output is in the run's folder. */
export const OUTPUT_KEPT = 16 * 1024;
/** SENTINEL_PREVIOUS is cut to this. */
const PREVIOUS_MAX = 256 * 1024;

type StepEnd =
  | { readonly kind: 'done'; readonly output: string; readonly channel?: string; readonly ms?: number }
  | { readonly kind: 'failed'; readonly why: string; readonly output?: string; readonly channel?: string; readonly ms?: number }
  | { readonly kind: 'skip'; readonly reason: string; readonly output?: string; readonly channel?: string }
  | { readonly kind: 'timeout'; readonly output?: string; readonly channel?: string }
  | { readonly kind: 'stopped'; readonly output?: string; readonly channel?: string };

const seconds = (ms: number): string => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);
const tail = (text: string, max = 400): string => {
  const t = text.trim();
  return t.length <= max ? t : `…${t.slice(t.length - max)}`;
};
const yymmdd = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getFullYear() % 100).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};
const USAGE = /usage limit|rate.?limit|limit (was )?reached|out of (extra )?usage/i;

export class SentinelRunner {
  constructor(private readonly deps: RunnerDeps) {}

  /** Run every step; `update` hears each change. → the run as it ended. */
  async execute(active: ActiveRun, update: (run: Run) => void): Promise<Run> {
    const { sentinel } = active;
    const set = (patch: Partial<Run>): void => {
      active.run = { ...active.run, ...patch };
      update(active.run);
    };
    const setStep = (i: number, patch: Partial<StepRun>): void => set({ steps: active.run.steps.map((s, n) => (n === i ? { ...s, ...patch } : s)) });
    set({ state: 'running' });
    const outputs: Array<{ readonly name: string; readonly output: string }> = [];
    const lastClaude = sentinel.steps.map((s) => s.kind).lastIndexOf('claude');
    let end: { readonly state: Run['state']; readonly why?: string; readonly headline?: string } | undefined;
    let report: string | undefined;
    let lastScript: { readonly ms: number; readonly exit?: number } | undefined;
    for (let i = 0; i < sentinel.steps.length && !end; i++) {
      const step = sentinel.steps[i]!;
      if (active.abort.signal.aborted) {
        end = { state: 'stopped', headline: 'Stopped by you' };
        break;
      }
      if (this.deps.now() >= active.deadline) {
        end = { state: 'failed', why: 'timed out', headline: `Timed out after ${sentinel.limits.minutes} min` };
        break;
      }
      const refused = this.refusal(sentinel, step);
      if (refused) {
        setStep(i, { state: 'failed', why: refused, startedAt: this.deps.now(), endedAt: this.deps.now() });
        end = { state: 'failed', why: refused, headline: `“${step.name}” can’t run: ${refused}` };
        break;
      }
      const startedAt = this.deps.now();
      setStep(i, { state: 'running', startedAt });
      let result: StepEnd;
      try {
        result = await this.step(active, step, i, outputs, i === lastClaude);
      } catch (err) {
        result = { kind: 'failed', why: err instanceof Error ? err.message : String(err) };
      }
      const endedAt = this.deps.now();
      const output = result.output === undefined ? undefined : redactSecrets(result.output);
      if (output !== undefined) {
        this.deps.folders.write(active.run.id, `step-${i + 1}.txt`, output);
        outputs.push({ name: step.name, output });
      }
      const kept = output === undefined ? {} : { output: output.slice(0, OUTPUT_KEPT) };
      const channel = result.channel ? { channel: result.channel } : {};
      if (result.channel && step.kind === 'claude') set({ channel: result.channel });
      if (step.kind === 'script' && result.kind !== 'stopped') {
        const ms = (result.kind === 'done' || result.kind === 'failed' ? result.ms : undefined) ?? endedAt - startedAt;
        lastScript = { ms, ...(result.kind === 'failed' && /^exit (\d+)/.test(result.why) ? { exit: Number(/^exit (\d+)/.exec(result.why)![1]) } : result.kind === 'done' ? { exit: 0 } : {}) };
      }
      switch (result.kind) {
        case 'done':
          setStep(i, { state: 'done', endedAt, ...kept, ...channel });
          if (step.kind === 'claude') report = output;
          break;
        case 'skip':
          setStep(i, { state: 'done', endedAt, ...kept, ...channel, why: result.reason });
          end = { state: 'skipped', why: result.reason, headline: capital(result.reason) };
          break;
        case 'failed':
          setStep(i, { state: 'failed', endedAt, ...kept, ...channel, why: result.why });
          end = { state: 'failed', why: result.why, headline: `${step.name}: ${firstLine(result.why, 100)}` };
          break;
        case 'timeout':
          setStep(i, { state: 'failed', endedAt, ...kept, ...channel, why: 'timed out' });
          end = { state: 'failed', why: 'timed out', headline: `Timed out after ${sentinel.limits.minutes} min` };
          break;
        case 'stopped':
          setStep(i, { state: 'failed', endedAt, ...kept, ...channel, why: 'stopped' });
          end = { state: 'stopped', headline: 'Stopped by you' };
          break;
      }
    }
    // Steps it never got to.
    set({ steps: active.run.steps.map((s) => (s.state === 'waiting' ? { ...s, state: 'skipped' } : s)) });
    if (report !== undefined) {
      this.deps.folders.write(active.run.id, 'report.md', report);
      const where = this.deps.folders.pathOf(active.run.id, 'report.md');
      if (where) set({ report: where });
    }
    const state = end?.state ?? 'done';
    const headline =
      end?.headline ??
      (report !== undefined && firstLine(report)
        ? firstLine(report)
        : lastScript && !sentinel.steps.some((s) => s.kind === 'claude')
          ? `Script ran · ${seconds(lastScript.ms)} · exit ${lastScript.exit ?? '?'}`
          : sentinel.steps.length
            ? `Done · ${sentinel.steps.length} ${sentinel.steps.length === 1 ? 'step' : 'steps'}`
            : 'Nothing to do: it has no steps');
    await this.settleWorktree(active);
    set({ state, headline, endedAt: this.deps.now(), ...(end?.why ? { why: end.why } : {}) });
    return active.run;
  }

  /** Why a step can't run in this run: a later phase's, or more than the sentinel's access allows. */
  private refusal(sentinel: Sentinel, step: Step): string | undefined {
    if (!stepAvailable(step.kind)) return `${STEP_INFO[step.kind].label} isn’t available yet: it comes with the next part of Sentinel`;
    const where = step.kind === 'claude' ? step.where : undefined;
    if (!accessAllows(sentinel.access, step.kind, where)) return `it needs ${ACCESS_INFO[accessNeeded(step.kind, where)].label} access, and this sentinel has ${ACCESS_INFO[sentinel.access].label}`;
    return undefined;
  }

  private step(active: ActiveRun, step: Step, index: number, outputs: ReadonlyArray<{ readonly name: string; readonly output: string }>, reports: boolean): Promise<StepEnd> {
    switch (step.kind) {
      case 'claude':
        return this.claudeStep(active, step, outputs, reports);
      case 'script':
        return this.scriptStep(active, step, outputs);
      case 'notify':
        return Promise.resolve(this.notifyStep(active, step, outputs));
      default:
        return Promise.resolve({ kind: 'failed', why: `${STEP_INFO[step.kind].label} isn’t available yet (step ${index + 1})` });
    }
  }

  /** What a step's templates see. */
  context(active: ActiveRun, outputs: ReadonlyArray<{ readonly name: string; readonly output: string }>): RenderContext {
    const s = active.sentinel;
    const project = s.projectId ? this.deps.project(s.projectId) : undefined;
    const own = this.deps.beluga(s.projectId);
    return {
      trigger: active.run.trigger,
      ...(outputs.length ? { previous: outputs.at(-1)!.output } : {}),
      steps: Object.fromEntries(outputs.map((o) => [o.name, o.output])),
      ...(project ? { project: { name: project.name, path: project.root } } : {}),
      date: dateText(this.deps.now()),
      sentinel: s.name,
      tasks: own.tasks,
      worktrees: own.worktrees,
      plans: own.plans,
    };
  }

  private async place(active: ActiveRun, step: ClaudeStep): Promise<SentinelPlace | string> {
    const made = active.places[step.where];
    if (made) return made;
    const places = this.deps.places;
    if (!places) return 'Claude’s conversations need the Beluga app';
    const s = active.sentinel;
    let place: SentinelPlace | undefined;
    if (step.where === 'mac') place = places.macChat();
    else {
      if (!s.projectId) return 'it needs a project: pick one on the sentinel’s page, or have Claude work on Your Mac';
      const at = this.deps.now();
      place = step.where === 'worktree' ? await places.worktree(s.projectId, `sentinel ${s.name} ${yymmdd(at)}`) : await places.projectChat(s.projectId, `${s.name} · ${dateText(at)}`);
    }
    if (!place) return step.where === 'worktree' ? 'the worktree couldn’t be made' : 'the conversation couldn’t be made';
    active.places[step.where] = place;
    if (step.where === 'worktree' && place.workspaceId) {
      active.run = { ...active.run, worktreeId: place.workspaceId };
    }
    return place;
  }

  private async claudeStep(active: ActiveRun, step: ClaudeStep, outputs: ReadonlyArray<{ readonly name: string; readonly output: string }>, reports: boolean): Promise<StepEnd> {
    const claude = this.deps.claude;
    if (!claude) return { kind: 'failed', why: 'your Claude isn’t on' };
    const place = await this.place(active, step);
    if (typeof place === 'string') return { kind: 'failed', why: place };
    const { channel } = place;
    const prompt = render(step.prompt, this.context(active, outputs)).trim();
    if (!prompt) return { kind: 'failed', why: 'its prompt is empty', channel };
    const signal = active.abort.signal;
    const remaining = (): number => Math.max(0, active.deadline - this.deps.now());
    // Waits for its turn (Run at Once), as long as the time limit allows.
    const waiting = this.deps.claudeTurn(signal);
    const turn = await race(waiting, remaining(), signal);
    if (turn.kind !== 'ok') {
      // A turn that comes after all goes straight back.
      void waiting.then((give) => give(), () => undefined);
      return turn.kind === 'timeout' ? { kind: 'timeout', channel } : { kind: 'stopped', channel };
    }
    const release = turn.value;
    try {
      const brief = sentinelRunPrompt({ sentinel: active.sentinel, trigger: active.run.trigger, steps: outputs, minutesLeft: remaining() / 60_000, reports });
      // Known before the run starts, so the run is told what it is (Sentinels.forRun).
      active.claude = { stepId: step.id, channel, brief };
      const requestId = claude.ask(prompt, channel, prompt);
      if (!requestId) return { kind: 'failed', why: 'your Claude couldn’t be asked there', channel };
      active.claude.requestId = requestId;
      const answer = await race(claude.wait(requestId).then((text) => ({ ok: true as const, text }), (err: unknown) => ({ ok: false as const, why: err instanceof Error ? err.message : String(err) })), remaining(), signal);
      if (answer.kind === 'timeout') {
        claude.cancel(requestId, 'Stopped by Beluga: the sentinel’s time limit');
        return { kind: 'timeout', channel };
      }
      if (answer.kind === 'aborted') {
        claude.cancel(requestId, 'Stopped by you: the sentinel’s run was stopped');
        return { kind: 'stopped', channel };
      }
      const said = answer.value;
      if (!said.ok) return { kind: 'failed', why: USAGE.test(said.why) ? 'usage limit' : firstLine(said.why, 200) || 'Claude stopped', channel };
      if (active.stopReason !== undefined) return { kind: 'skip', reason: active.stopReason, output: said.text, channel };
      return { kind: 'done', output: said.text, channel };
    } finally {
      active.claude = undefined;
      release();
    }
  }

  private async scriptStep(active: ActiveRun, step: ScriptStep, outputs: ReadonlyArray<{ readonly name: string; readonly output: string }>): Promise<StepEnd> {
    const s = active.sentinel;
    const project = s.projectId ? this.deps.project(s.projectId) : undefined;
    const cwd = step.cwd === 'project' && project?.root ? project.root : this.deps.home;
    const previous = outputs.at(-1)?.output ?? '';
    const env = {
      ...this.deps.envFor(cwd),
      SENTINEL_RUN_DIR: this.deps.folders.folder(active.run.id) ?? '',
      SENTINEL_TRIGGER: JSON.stringify(active.run.trigger),
      SENTINEL_PREVIOUS: previous.length > PREVIOUS_MAX ? previous.slice(0, PREVIOUS_MAX) : previous,
    };
    const remaining = Math.max(0, active.deadline - this.deps.now());
    const own = Math.min(3600, Math.max(1, step.timeoutSec)) * 1000;
    const limit = Math.min(own, remaining);
    const res = await this.deps.shell(step.command, cwd, limit, env, active.abort.signal);
    if (active.abort.signal.aborted) return { kind: 'stopped', output: res.output };
    if (res.timedOut) return limit < own ? { kind: 'timeout', output: res.output } : { kind: 'failed', why: `took longer than ${Math.round(own / 1000)} s`, output: res.output };
    if (res.exitCode !== 0) return { kind: 'failed', why: `exit ${res.exitCode ?? '?'}${res.output.trim() ? `: ${tail(res.output)}` : ''}`, output: res.output, ms: res.ms };
    return { kind: 'done', output: res.output, ms: res.ms };
  }

  private notifyStep(active: ActiveRun, step: NotifyStep, outputs: ReadonlyArray<{ readonly name: string; readonly output: string }>): StepEnd {
    const ctx = this.context(active, outputs);
    const title = firstLine(render(step.title?.trim() || '{{sentinel}}', ctx), 120) || active.sentinel.name;
    const body = (step.body?.trim() ? render(step.body, ctx) : firstLine(ctx.previous ?? '', 200)) || 'It ran';
    const channel = active.run.channel;
    // The run's id is the key: its end isn't told again.
    this.deps.notify({ kind: 'done', tag: 'sentinel', title, body: firstLine(body, 300), key: active.run.id, ...(channel ? { channel } : {}) });
    // TODO(BLG-237 screens): with step.phone, the phone's `done` nudge with collapse `sentinel:<id>`
    // (src/companion/host.ts notice() / push.ts), the report as an output of the run's topic.
    return { kind: 'done', output: `Told you${step.phone ? ' (Mac and phone)' : ''}: ${title}${body ? ` · ${firstLine(body, 200)}` : ''}` };
  }

  /** A worktree whose run made no commit (and changed nothing) goes quietly; one with work stays. */
  private async settleWorktree(active: ActiveRun): Promise<void> {
    const id = active.run.worktreeId;
    const places = this.deps.places;
    if (!id || !places) return;
    try {
      if ((await places.madeChanges(id)) === false) await places.archive(id);
    } catch {
      // It stays: nothing is lost.
    }
  }
}

const capital = (text: string): string => (text ? text[0]!.toUpperCase() + text.slice(1) : text);

type Raced<T> = { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'timeout' } | { readonly kind: 'aborted' };

/** A promise against the time left and a stop. */
function race<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<Raced<T>> {
  if (signal.aborted) return Promise.resolve({ kind: 'aborted' });
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({ kind: 'timeout' }), ms);
    timer.unref?.();
    const onAbort = (): void => finish({ kind: 'aborted' });
    signal.addEventListener('abort', onAbort, { once: true });
    let done = false;
    function finish(r: Raced<T>): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(r);
    }
    p.then(
      (value) => finish({ kind: 'ok', value }),
      () => finish({ kind: 'aborted' }),
    );
  });
}

const MAX_OUTPUT = 1024 * 1024;

/**
 * A script as you (peer-run.ts's runShell, with your environment): no input, output capped (the
 * tail kept), the whole process group killed at its time limit or when the run is stopped.
 */
export const runSentinelShell: SentinelShell = (command, cwd, timeoutMs, env, signal) =>
  new Promise((resolve) => {
    const started = Date.now();
    let out = '';
    let truncated = false;
    let timedOut = false;
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, ...env, CI: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' },
    });
    const take = (chunk: Buffer): void => {
      out += chunk.toString('utf8');
      if (out.length > MAX_OUTPUT) {
        out = out.slice(out.length - MAX_OUTPUT);
        truncated = true;
      }
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const kill = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    timer.unref?.();
    const onAbort = (): void => kill();
    signal.addEventListener('abort', onAbort, { once: true });
    const finish = (exitCode: number | undefined, extra = ''): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ ...(exitCode === undefined ? {} : { exitCode }), output: out + extra, truncated, timedOut, ms: Date.now() - started });
    };
    child.on('error', (err) => finish(undefined, `${out ? '\n' : ''}${err.message}`));
    child.on('close', (code, sig) => finish(code ?? (sig ? 128 + (os.constants.signals[sig] ?? 0) : undefined)));
  });
