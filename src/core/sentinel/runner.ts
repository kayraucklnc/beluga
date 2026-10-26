import { spawn } from 'node:child_process';
import os from 'node:os';
import { redactSecrets } from '../../shared/steps.js';
import type { NoticeEvent } from '../notify.js';
import { type Named, mentionNote, personMentions } from '../person-mentions.js';
import type { RunFolders } from './files.js';
import {
  type ClaudeStep,
  type FriendStep,
  type HttpStep,
  type MergeStep,
  type MessageStep,
  type NotifyStep,
  type PrStep,
  type Run,
  type ScriptStep,
  type Sentinel,
  type Step,
  type StepRun,
  type TriggerStep,
  APPROVAL_MS,
  STEP_INFO,
  accessAllows,
  accessNeeded,
  ACCESS_INFO,
  firstLine,
  stepAvailable,
} from './model.js';
import { sentinelRunPrompt, stepMaterial } from './prompt.js';
import { type RenderContext, dateText, jsonInside, render } from './render.js';

/**
 * A run's steps, one after the other (docs/sentinel.md §4, "Runner"): Ask Claude, Run a script,
 * Notify me, Call a service, Open a pull request, Merge if acceptable (§5), Message a chat, Ask a
 * friend's Claude, Run another sentinel. A step's output is text; the run stops when a script exits
 * non-zero, a service answers an error, Claude calls sentinel_stop (skipped: nothing to do), the
 * time limit is reached, or you stop it. Steps of later phases are refused with a clear line.
 * Everything it needs is injected, so the tests fake it.
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

/** A pull request as GitHub sees it now (for the merge gate, §5). */
export interface PrLook {
  readonly number: number;
  readonly url: string;
  readonly state: 'OPEN' | 'MERGED' | 'CLOSED';
  readonly draft: boolean;
  readonly conflicts: boolean;
  readonly checks: 'passing' | 'pending' | 'failing' | 'none';
  /** The checks that failed, by name. */
  readonly failed: readonly string[];
  /** How many checks it has. */
  readonly count: number;
}

/** Where a run's pull request lives: its worktree, else the project's main folder. */
export interface PrPlace {
  readonly workspaceId?: string;
  readonly projectId?: string;
}

export interface PrRef {
  readonly number: number;
  readonly url: string;
}

/** GitHub for the pull request and merge steps (the workbench and gh; fakes in the tests). Each answers why not in words. */
export interface SentinelGitHub {
  /** Push the worktree and open a pull request (the project's PR instructions, or its commits). */
  openPr(workspaceId: string, opts: { readonly draft: boolean }): Promise<PrRef | string>;
  look(where: PrPlace, number: number): Promise<PrLook | string>;
  /** A one-shot reviewer (read-only, a small model, two minutes): ship or hold, in one sentence. Undefined: it couldn't. */
  review(where: PrPlace, pr: PrRef): Promise<{ readonly verdict: 'ship' | 'hold'; readonly line: string } | undefined>;
  merge(where: PrPlace, pr: PrRef, method: MergeStep['method']): Promise<true | string>;
}

/** The Beluga network's chats, as you (Message a chat). */
export interface SentinelChat {
  /** Write in `dm:<peerId>` or `group:<id>`; throws in words. */
  post(to: string, text: string): void;
  /** The chat's name ("Ata", "Launch crew"). */
  nameOf(to: string): string | undefined;
  readonly friends: () => readonly Named[];
  /** Whether a friend is in that chat (and sees the message there). */
  shares(to: string, peerId: string): boolean;
  /** A direct message saying where you mentioned them. */
  tell(peerId: string, note: string): void;
  readonly me: () => string;
}

/** A friend's Claude through the gateway, as you (their trust applies). */
export interface FriendAnswer {
  readonly state: string;
  readonly final: boolean;
  readonly summary?: string;
  readonly data?: unknown;
  /** Whose Claude answered. */
  readonly name?: string;
}

export interface SentinelFriends {
  /** → the request's id; throws in words (not a friend, their Mac can't take it). */
  ask(input: { readonly person: string; readonly ask: string; readonly summary: string; readonly project?: string }): string;
  /** Until it ends or `ms` pass: its state, and its answer once done. */
  wait(id: string, ms: number): Promise<FriendAnswer>;
  cancel(id: string): void;
}

/** Your answer to a merge waiting for you, and how it went (the API call that sent it waits for this). */
export interface YourAnswer {
  readonly choice: 'merge' | 'skip' | 'expired';
  readonly settle?: (why?: string) => void;
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
  /** How long a cancelled Claude request may take to end before its worktree is looked at (10 s). */
  readonly cancelGraceMs?: number;
  readonly fetch?: typeof fetch;
  readonly github?: SentinelGitHub;
  readonly chat?: SentinelChat;
  readonly friends?: SentinelFriends;
  /** Run another sentinel (Run another sentinel) with this run's last output → its name; throws in words. */
  readonly startOther?: (sentinelId: string, from: ActiveRun, output: string | undefined) => string;
  /** Wait for your Merge or Not Now (Sentinels.decide), or 24 hours. */
  readonly waitForYou?: (active: ActiveRun) => Promise<YourAnswer>;
  /** How often pending checks are looked at again (PR_FAST_MS, 15 s). */
  readonly pollMs?: number;
}

const CANCEL_GRACE_MS = 10_000;
const POLL_MS = 15_000;
/** A service's answer kept at most (the step fails above it). */
const MAX_ANSWER = 4 * 1024 * 1024;

/** A run going now: what the runner and Sentinels share about it. */
export interface ActiveRun {
  run: Run;
  readonly sentinel: Sentinel;
  readonly abort: AbortController;
  /** When its time limit is reached (moved on by the time it waited for you). */
  deadline: number;
  /** The Claude step running now: its request, its conversation, and what Claude is told there. */
  claude?: { readonly stepId: string; readonly channel: string; readonly brief: string; requestId?: string };
  /** Claude said there's nothing to do (sentinel_stop). */
  stopReason?: string;
  /** Places made in this run, reused by its later steps. */
  places: Partial<Record<'project' | 'worktree' | 'mac', SentinelPlace>>;
  /** Claude requests cancelled in this run, settling (done or error): the worktree waits for them. */
  cancelling?: Promise<unknown>[];
  /** Waiting for your Merge or Not Now: answer it (Sentinels.decide). */
  answer?: (choice: 'merge' | 'skip') => Promise<void>;
  /** The pull request it merged. */
  merged?: number;
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
  | { readonly kind: 'stopped'; readonly output?: string; readonly channel?: string }
  /** The run ends here as you said (Not Now, nobody answered): stopped, with its own line. */
  | { readonly kind: 'end'; readonly headline: string; readonly why: string; readonly output?: string; readonly channel?: string };

/** What a step may change on its run while it goes (the merge's needs-you, the pull request). */
interface Live {
  readonly run: (patch: Partial<Run>) => void;
  readonly step: (patch: Partial<StepRun>) => void;
}

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
        result = await this.step(active, step, i, outputs, i === lastClaude, { run: set, step: (patch) => setStep(i, patch) });
      } catch (err) {
        result = { kind: 'failed', why: err instanceof Error ? err.message : String(err) };
      }
      // Nothing leaves a step with a secret in it: its output, why it failed, why it stopped.
      if (result.kind === 'failed' || result.kind === 'end') result = { ...result, why: redactSecrets(result.why) };
      else if (result.kind === 'skip') result = { ...result, reason: redactSecrets(result.reason) };
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
        case 'end':
          setStep(i, { state: 'skipped', endedAt, ...kept, why: result.why });
          end = { state: 'stopped', why: result.why, headline: result.headline };
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
      (active.merged !== undefined
        ? `Merged #${active.merged}`
        : report !== undefined && firstLine(report)
        ? firstLine(report)
        : lastScript && !sentinel.steps.some((s) => s.kind === 'claude')
          ? `Script ran · ${seconds(lastScript.ms)} · exit ${lastScript.exit ?? '?'}`
          : sentinel.steps.length
            ? `Done · ${sentinel.steps.length} ${sentinel.steps.length === 1 ? 'step' : 'steps'}`
            : 'Nothing to do: it has no steps');
    await this.settleWorktree(active);
    set({ state, headline: redactSecrets(headline), endedAt: this.deps.now(), ...(end?.why ? { why: redactSecrets(end.why) } : {}) });
    return active.run;
  }

  /** Why a step can't run in this run: a later phase's, or more than the sentinel's access allows. */
  private refusal(sentinel: Sentinel, step: Step): string | undefined {
    if (!stepAvailable(step.kind)) return `${STEP_INFO[step.kind].label} isn’t available yet: it comes with the next part of Sentinel`;
    const where = step.kind === 'claude' ? step.where : undefined;
    if (!accessAllows(sentinel.access, step.kind, where)) return `it needs ${ACCESS_INFO[accessNeeded(step.kind, where)].label} access, and this sentinel has ${ACCESS_INFO[sentinel.access].label}`;
    return undefined;
  }

  private step(active: ActiveRun, step: Step, index: number, outputs: Outputs, reports: boolean, live: Live): Promise<StepEnd> {
    switch (step.kind) {
      case 'claude':
        return this.claudeStep(active, step, outputs, reports);
      case 'script':
        return this.scriptStep(active, step, outputs);
      case 'notify':
        return Promise.resolve(this.notifyStep(active, step, outputs));
      case 'http':
        return this.httpStep(active, step, outputs);
      case 'pr':
        return this.prStep(active, step, live);
      case 'merge':
        return this.mergeStep(active, step, live);
      case 'message':
        return Promise.resolve(this.messageStep(active, step, outputs));
      case 'friend':
        return this.friendStep(active, step, outputs);
      case 'trigger':
        return Promise.resolve(this.triggerStep(active, step, outputs));
      default:
        return Promise.resolve({ kind: 'failed', why: `${STEP_INFO[(step as Step).kind].label} isn’t available yet (step ${index + 1})` });
    }
  }

  private remaining(active: ActiveRun): number {
    return Math.max(0, active.deadline - this.deps.now());
  }

  /** The folder a step works from: the project's main folder, else your home. */
  private cwdOf(s: Sentinel): string {
    const project = s.projectId ? this.deps.project(s.projectId) : undefined;
    return project?.root || this.deps.home;
  }

  // ---------------------------------------------------------------- Call a service

  private async httpStep(active: ActiveRun, step: HttpStep, outputs: Outputs): Promise<StepEnd> {
    const env = this.deps.envFor(this.cwdOf(active.sentinel));
    // Your variables go in first, into what you wrote only: an earlier output saying "$GROQBOT_KEY"
    // is never filled in (and sent somewhere).
    const secrets: string[] = [];
    const missing = new Set<string>();
    const expand = (text: string, strict: boolean): string =>
      text.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name: string) => {
        const v = env[name];
        if (v === undefined) {
          if (strict) missing.add(name);
          return whole;
        }
        if (v.length >= 4) secrets.push(v);
        return v;
      });
    const ctx = this.context(active, outputs);
    const url = render(expand(step.url.trim(), true), { ...ctx, escape: encodeURIComponent }).trim();
    const headers: Record<string, string> = { 'user-agent': 'Beluga Sentinel' };
    for (const [k, v] of Object.entries(step.headers)) if (k.trim()) headers[k.trim()] = render(expand(v, true), ctx).replace(/[\r\n]+/g, ' ');
    if (missing.size) return { kind: 'failed', why: `${[...missing].map((n) => `$${n}`).join(', ')} ${missing.size === 1 ? 'isn’t' : 'aren’t'} set: add ${missing.size === 1 ? 'it' : 'them'} in Settings › Environment` };
    if (!url) return { kind: 'failed', why: 'it has no address yet: fill in the URL' };
    if (!/^https?:\/\/[^/\s]+/i.test(url)) return { kind: 'failed', why: 'its address must start with https:// (or http://)' };
    const host = /^https?:\/\/([^/?#]+)/i.exec(url)?.[1] ?? 'the service';
    const rawBody = step.body !== undefined && step.method !== 'GET' ? expand(step.body, false) : undefined;
    const json = /json/i.test(Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '') || /^\s*[[{]/.test(rawBody ?? '');
    const body = rawBody === undefined ? undefined : render(rawBody, json ? { ...ctx, escape: jsonInside } : ctx);
    // Nothing a service says back carries your secrets on (a service echoing its key).
    const scrub = (text: string): string => secrets.reduce((t, v) => t.split(v).join('[redacted]'), text);
    const own = Math.min(600, Math.max(1, step.timeoutSec)) * 1000;
    const limit = Math.min(own, this.remaining(active));
    const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1, limit)), active.abort.signal]);
    let res: Response;
    try {
      res = await (this.deps.fetch ?? fetch)(url, { method: step.method, headers, ...(body !== undefined ? { body } : {}), signal, redirect: 'follow' });
    } catch (err) {
      if (active.abort.signal.aborted) return { kind: 'stopped' };
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return limit < own ? { kind: 'timeout' } : { kind: 'failed', why: `${host} didn’t answer in ${Math.round(own / 1000)} s` };
      const cause = err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : String(err);
      return { kind: 'failed', why: scrub(`couldn’t reach ${host}: ${cause}`) };
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      if (active.abort.signal.aborted) return { kind: 'stopped' };
      return { kind: 'failed', why: scrub(`${host}’s answer broke off: ${err instanceof Error ? err.message : String(err)}`) };
    }
    if (text.length > MAX_ANSWER) text = `${text.slice(0, MAX_ANSWER)}\n… (cut: the answer was bigger than 4 MB)`;
    text = scrub(text);
    if (!res.ok) return { kind: 'failed', why: `${host} answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${text.trim() ? `: ${firstLine(text, 200)}` : ''}`, output: text };
    return { kind: 'done', output: text };
  }

  // ---------------------------------------------------------------- Open a pull request

  private async prStep(active: ActiveRun, step: PrStep, live: Live): Promise<StepEnd> {
    const worktree = active.run.worktreeId;
    if (!worktree) return { kind: 'failed', why: 'there’s no worktree to open a pull request from: an “Ask Claude” step in a new worktree comes first' };
    const open = active.run.pr;
    if (open) return { kind: 'done', output: `#${open.number} is open already: ${open.url}` };
    const gh = this.deps.github;
    if (!gh) return { kind: 'failed', why: 'pull requests need the Beluga app' };
    const got = await race(gh.openPr(worktree, { draft: Boolean(step.draft) }).catch((err: unknown) => (err instanceof Error ? err.message : String(err))), this.remaining(active), active.abort.signal);
    if (got.kind === 'timeout') return { kind: 'timeout' };
    if (got.kind === 'aborted') return { kind: 'stopped' };
    const pr = got.value;
    if (typeof pr === 'string') return { kind: 'failed', why: pr };
    live.run({ pr });
    return { kind: 'done', output: `Opened #${pr.number}${step.draft ? ' as a draft' : ''}: ${pr.url}` };
  }

  // ---------------------------------------------------------------- Merge if acceptable (§5)

  /**
   * "Acceptable" is Beluga's: a pull request, every check passed (pending ones waited for), a
   * reviewer's ship, and your Merge (unless the step merges by itself); then it merges and the
   * worktree is archived.
   */
  private async mergeStep(active: ActiveRun, step: MergeStep, live: Live): Promise<StepEnd> {
    const pr = active.run.pr;
    if (!pr) return { kind: 'failed', why: 'there’s no pull request to merge: an “Open a pull request” step comes first' };
    const gh = this.deps.github;
    if (!gh) return { kind: 'failed', why: 'merging needs the Beluga app' };
    const where: PrPlace = { ...(active.run.worktreeId ? { workspaceId: active.run.worktreeId } : {}), ...(active.sentinel.projectId ? { projectId: active.sentinel.projectId } : {}) };
    const signal = active.abort.signal;
    const n = `#${pr.number}`;
    // 2. The checks: every one passed; pending ones are waited for (up to the run's time limit).
    let look: PrLook | undefined;
    let sawNone = false;
    let waited = false;
    while (!look) {
      const got = await race(gh.look(where, pr.number).catch((err: unknown) => (err instanceof Error ? err.message : String(err))), this.remaining(active), signal);
      if (got.kind === 'timeout') return { kind: 'timeout' };
      if (got.kind === 'aborted') return { kind: 'stopped' };
      const now = got.value;
      if (typeof now === 'string') return { kind: 'failed', why: `GitHub couldn’t say how ${n} is doing: ${now}` };
      if (now.state === 'MERGED') {
        active.merged = pr.number;
        return { kind: 'done', output: `${n} is merged already` };
      }
      if (now.state === 'CLOSED') return { kind: 'failed', why: `${n} is closed` };
      if (now.draft) return { kind: 'failed', why: `${n} is a draft: a draft can’t merge (untick Draft on the pull request step)` };
      if (now.conflicts) return { kind: 'failed', why: `${n} conflicts with its base branch` };
      if (now.checks === 'failing') return { kind: 'failed', why: `the check “${now.failed[0] ?? 'a check'}” failed on ${n}` };
      // No checks at all: looked at twice, so checks that haven't shown up yet aren't missed.
      if (now.checks === 'passing' || (now.checks === 'none' && sawNone)) look = now;
      else {
        if (now.checks === 'none') sawNone = true;
        if (!waited) live.step({ why: now.checks === 'pending' ? `Waiting for the checks on ${n}` : `Looking for checks on ${n}` });
        waited = true;
        const pause = await race(delay(this.deps.pollMs ?? POLL_MS), this.remaining(active), signal);
        if (pause.kind === 'timeout') return { kind: 'timeout' };
        if (pause.kind === 'aborted') return { kind: 'stopped' };
      }
    }
    const checks = look.checks === 'none' ? 'No checks on this repository' : look.count === 1 ? 'The check passed' : `All ${look.count} checks passed`;
    // 3. The review: ship or hold, in one sentence.
    live.step({ why: `${checks} · Claude is reviewing ${n}` });
    const reviewed = await race(gh.review(where, pr).catch(() => undefined), this.remaining(active), signal);
    if (reviewed.kind === 'timeout') return { kind: 'timeout' };
    if (reviewed.kind === 'aborted') return { kind: 'stopped' };
    const review = reviewed.value;
    const said = review ? `Claude’s review: ${review.verdict}, ${lowerFirst(review.line.replace(/[.\s]+$/, ''))}` : 'Claude couldn’t review it';
    const why = `${checks} · ${said}`;
    live.step({ why });
    // 4. Your approval (a hold always asks).
    const hold = !review || review.verdict === 'hold';
    if (step.require.approval || hold) {
      const wait = this.deps.waitForYou;
      if (!wait) return { kind: 'failed', why: `${n} needs your approval, and nothing can ask you here` };
      const headline = hold ? `${n}: Claude says hold. Merge it anyway?` : `Merge ${n}?`;
      live.run({ state: 'needs-you', headline });
      this.deps.notify({ kind: 'needsYou', tag: 'sentinel', title: `${active.sentinel.name}: merge ${n}?`, body: why, key: `${active.run.id}:merge`, ...(active.run.channel ? { channel: active.run.channel } : {}) });
      const since = this.deps.now();
      const asked = await race(wait(active), APPROVAL_MS + 60_000, signal);
      // The time it waited for you doesn't count against its time limit.
      active.deadline += this.deps.now() - since;
      live.run({ state: 'running', headline: '' });
      if (asked.kind !== 'ok') return { kind: 'stopped' };
      const answer = asked.value;
      if (answer.choice === 'skip') {
        answer.settle?.();
        return { kind: 'end', headline: `Not now: ${n} stays open`, why: `${why} · you said Not Now` };
      }
      if (answer.choice === 'expired') return { kind: 'end', headline: `Nobody said Merge in 24 hours: ${n} stays open`, why: `${why} · nobody said Merge in 24 hours` };
      const merged = await this.merge(active, gh, where, pr, step);
      answer.settle?.(typeof merged === 'string' ? merged : undefined);
      return typeof merged === 'string' ? { kind: 'failed', why: merged } : merged;
    }
    const merged = await this.merge(active, gh, where, pr, step);
    return typeof merged === 'string' ? { kind: 'failed', why: merged } : merged;
  }

  /** 5. Merge it, then archive the worktree (its work is on the base branch now). */
  private async merge(active: ActiveRun, gh: SentinelGitHub, where: PrPlace, pr: PrRef, step: MergeStep): Promise<StepEnd | string> {
    const n = `#${pr.number}`;
    const res = await gh.merge(where, pr, step.method).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
    if (res !== true) return `GitHub didn’t merge ${n}: ${res}`;
    active.merged = pr.number;
    let archived = false;
    if (where.workspaceId && this.deps.places) {
      try {
        await this.deps.places.archive(where.workspaceId);
        archived = true;
      } catch {
        // It stays; nothing is lost.
      }
    }
    return { kind: 'done', output: `Merged ${n} (${step.method === 'squash' ? 'squashed' : 'a merge commit'})${archived ? '; its worktree is archived' : ''}` };
  }

  // ---------------------------------------------------------------- Message a chat

  private messageStep(active: ActiveRun, step: MessageStep, outputs: Outputs): StepEnd {
    const chat = this.deps.chat;
    if (!chat) return { kind: 'failed', why: 'messages need the Beluga network: turn it on in Settings › Network' };
    if (!step.to) return { kind: 'failed', why: 'pick the chat it writes in' };
    // What a template fills in may hold a secret: never in a chat.
    const text = redactSecrets(render(step.text, this.context(active, outputs))).trim();
    if (!text) return { kind: 'failed', why: 'its message is empty' };
    chat.post(step.to, text);
    const name = chat.nameOf(step.to);
    // "@ata" tags Ata; one who isn't in this chat is told where (as a message you sent would).
    const told: string[] = [];
    const where = name ? (step.to.startsWith('group:') ? `the group “${name}”` : `your chat with ${name}`) : 'a chat';
    for (const f of personMentions(text, chat.friends())) {
      if (chat.shares(step.to, f.peerId)) {
        told.push(f.name);
        continue;
      }
      try {
        chat.tell(f.peerId, mentionNote(chat.me(), where, text));
        told.push(f.name);
      } catch {
        // They'll see it when they're back in it.
      }
    }
    return { kind: 'done', output: `Sent to ${name ?? step.to}: ${firstLine(text, 200)}${told.length ? ` · tagged ${told.join(', ')}` : ''}` };
  }

  // ---------------------------------------------------------------- Ask a friend's Claude

  private async friendStep(active: ActiveRun, step: FriendStep, outputs: Outputs): Promise<StepEnd> {
    const friends = this.deps.friends;
    if (!friends) return { kind: 'failed', why: 'asking a friend’s Claude needs the Beluga network: turn it on in Settings › Network' };
    if (!step.peerId) return { kind: 'failed', why: 'pick whose Claude it asks' };
    // It goes to someone else's Mac: nothing that looks like a secret goes with it.
    const ask = redactSecrets(render(step.prompt, { ...this.context(active, outputs), material: stepMaterial })).trim();
    if (!ask) return { kind: 'failed', why: 'its question is empty' };
    const id = friends.ask({ person: step.peerId, ask, summary: `${active.sentinel.name}: ${firstLine(ask, 80)}`, ...(step.project ? { project: step.project } : {}) });
    const signal = active.abort.signal;
    for (;;) {
      const left = this.remaining(active);
      const got = await race(friends.wait(id, left).catch((err: unknown): FriendAnswer => ({ state: 'failed', final: true, summary: err instanceof Error ? err.message : String(err) })), left, signal);
      if (got.kind !== 'ok') {
        friends.cancel(id);
        return got.kind === 'timeout' ? { kind: 'timeout' } : { kind: 'stopped' };
      }
      const t = got.value;
      if (!t.final) {
        // A question back from their Claude: nobody answers it here; it waits for the end (or the time limit).
        if (this.remaining(active) <= 0) {
          friends.cancel(id);
          return { kind: 'timeout' };
        }
        const pause = await race(delay(1000), this.remaining(active), signal);
        if (pause.kind === 'aborted') {
          friends.cancel(id);
          return { kind: 'stopped' };
        }
        continue;
      }
      const who = t.name ?? 'Their Claude';
      if (t.state !== 'done') return { kind: 'failed', why: `${who} ${t.state === 'declined' ? 'said no' : t.state}${t.summary ? `: ${firstLine(t.summary, 200)}` : ''}` };
      const data = t.data === undefined ? '' : `\n\n${JSON.stringify(t.data, null, 2)}`;
      return { kind: 'done', output: `${t.summary ?? ''}${data}`.trim() || `${who} answered` };
    }
  }

  // ---------------------------------------------------------------- Run another sentinel

  private triggerStep(active: ActiveRun, step: TriggerStep, outputs: Outputs): StepEnd {
    if (!step.sentinelId) return { kind: 'failed', why: 'pick the sentinel it runs' };
    const start = this.deps.startOther;
    if (!start) return { kind: 'failed', why: 'running another sentinel needs the Beluga app' };
    const name = start(step.sentinelId, active, outputs.at(-1)?.output);
    return { kind: 'done', output: `Started “${name}”` };
  }

  /** What a step's templates see. */
  context(active: ActiveRun, outputs: ReadonlyArray<{ readonly name: string; readonly output: string }>): RenderContext {
    const s = active.sentinel;
    const project = s.projectId ? this.deps.project(s.projectId) : undefined;
    const own = this.deps.beluga(s.projectId);
    return {
      trigger: active.run.trigger,
      ...(outputs.length ? { previous: outputs.at(-1)!.output, previousName: outputs.at(-1)!.name } : {}),
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
    // Earlier outputs filled in are material in tags, never instructions.
    const prompt = render(step.prompt, { ...this.context(active, outputs), material: stepMaterial }).trim();
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
      const settled = claude.wait(requestId).then((text) => ({ ok: true as const, text }), (err: unknown) => ({ ok: false as const, why: err instanceof Error ? err.message : String(err) }));
      const answer = await race(settled, remaining(), signal);
      // Cancelled: the run goes on ending, but its worktree waits for the request's end (settleWorktree).
      const cancel = (note: string): void => {
        claude.cancel(requestId, note);
        (active.cancelling ??= []).push(settled);
      };
      if (answer.kind === 'timeout') {
        cancel('Stopped by Beluga: the sentinel’s time limit');
        return { kind: 'timeout', channel };
      }
      if (answer.kind === 'aborted') {
        cancel('Stopped by you: the sentinel’s run was stopped');
        return { kind: 'stopped', channel };
      }
      const said = answer.value;
      if (!said.ok) return { kind: 'failed', why: USAGE.test(said.why) ? 'usage limit' : firstLine(redactSecrets(said.why), 200) || 'Claude stopped', channel };
      if (active.stopReason !== undefined) return { kind: 'skip', reason: active.stopReason, output: said.text, channel };
      return { kind: 'done', output: said.text, channel };
    } finally {
      active.claude = undefined;
      release();
    }
  }

  private async scriptStep(active: ActiveRun, step: ScriptStep, outputs: ReadonlyArray<{ readonly name: string; readonly output: string }>): Promise<StepEnd> {
    if (!step.command.trim()) return { kind: 'failed', why: 'its command is empty: fill it in' };
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
    // `why` (the headline, the notification) is built from the output with its secrets redacted.
    const said = redactSecrets(res.output);
    if (res.exitCode !== 0) return { kind: 'failed', why: `exit ${res.exitCode ?? '?'}${said.trim() ? `: ${tail(said)}` : ''}`, output: res.output, ms: res.ms };
    return { kind: 'done', output: res.output, ms: res.ms };
  }

  private notifyStep(active: ActiveRun, step: NotifyStep, outputs: ReadonlyArray<{ readonly name: string; readonly output: string }>): StepEnd {
    const ctx = this.context(active, outputs);
    // What a template fills in (the trigger's payload among it) may hold a secret: never in a notification.
    const title = firstLine(redactSecrets(render(step.title?.trim() || '{{sentinel}}', ctx)), 120) || active.sentinel.name;
    const body = redactSecrets((step.body?.trim() ? render(step.body, ctx) : firstLine(ctx.previous ?? '', 200)) || 'It ran');
    const channel = active.run.channel;
    // The run's id is the key: its end isn't told again.
    this.deps.notify({ kind: 'done', tag: 'sentinel', title, body: firstLine(body, 300), key: active.run.id, ...(channel ? { channel } : {}) });
    // With step.phone, the companion host tells the phone when the run ends (src/companion/views.ts
    // sentinelDone: a `done` nudge collapsed as `sentinel:<id>`, the report on the sentinel's page).
    return { kind: 'done', output: `Told you${step.phone ? ' (Mac and phone)' : ''}: ${title}${body ? ` · ${firstLine(body, 200)}` : ''}` };
  }

  /** A worktree whose run made no commit (and changed nothing) goes quietly; one with work stays. */
  private async settleWorktree(active: ActiveRun): Promise<void> {
    const id = active.run.worktreeId;
    const places = this.deps.places;
    if (!id || !places) return;
    // A Claude request cancelled in it may still be writing: wait for its end (or a grace), so what
    // it changed is seen and the worktree isn't archived under it.
    if (active.cancelling?.length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.deps.cancelGraceMs ?? CANCEL_GRACE_MS);
        timer.unref?.();
      });
      await Promise.race([Promise.all(active.cancelling), grace]);
      clearTimeout(timer);
    }
    try {
      if ((await places.madeChanges(id)) === false) await places.archive(id);
    } catch {
      // It stays: nothing is lost.
    }
  }
}

const capital = (text: string): string => (text ? text[0]!.toUpperCase() + text.slice(1) : text);
const lowerFirst = (text: string): string => (text && !/^[A-Z]{2}/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text);

type Outputs = ReadonlyArray<{ readonly name: string; readonly output: string }>;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

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
