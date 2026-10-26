import { randomUUID } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readJson, writeJson } from '../../net/mesh/files.js';
import type { Store } from '../store.js';
import { unexplained } from './criteria.js';
import { dropKeptFile, dropProofFolder, keepProofFile, keepProofFiles, letGoProofFile } from './proof-files.js';
import {
  type Activity,
  type ActivityKind,
  type Actor,
  type Assignee,
  BRIEF_SECTIONS,
  type BoardProject,
  type BoardState,
  type BriefRevision,
  type BriefSection,
  ISSUE_STATUSES,
  type Issue,
  type IssueGitHub,
  type IssueLink,
  type IssuePlan,
  type IssuePr,
  type IssueStatus,
  COALESCE_MS,
  KEEP_ACTIVITY,
  KEEP_PROOF,
  KEEP_REVISIONS,
  PRIORITIES,
  PRIORITY_INFO,
  type Priority,
  type Proof,
  SECTION_INFO,
  STATUS_INFO,
  byRank,
  findIssue,
  isArchived,
  isOpen,
  prefixFor,
  rankBetween,
  renamedActors,
} from './model.js';

/**
 * The board: tasks per project, kept in ~/.beluga/board.json (readable only by you) and mirrored
 * into the shared state for every screen. Every change says who made it and goes into the
 * task's activity; brief edits keep their revisions. Without a folder (tests) it stays in memory.
 */

export interface BoardDeps {
  readonly store: Store;
  /** Where board.json lives; null: memory only. */
  readonly dir: string | null;
  /** A project's name (its key prefix comes from it), if the project is known. */
  readonly projectName: (projectId: string) => string | undefined;
  readonly now?: () => number;
  /** How long to wait before writing changes (several in a row are written once). */
  readonly saveDelayMs?: number;
}

export interface NewIssue {
  readonly projectId: string;
  readonly title: string;
  readonly status?: IssueStatus;
  readonly priority?: Priority;
  readonly assignee?: Assignee;
  readonly labels?: readonly string[];
  readonly estimate?: number;
  readonly due?: string;
  readonly parent?: string;
  readonly blockedBy?: readonly string[];
  readonly brief?: Partial<Record<BriefSection, string>>;
  readonly autoTitle?: boolean;
  readonly drafting?: boolean;
  readonly plan?: IssuePlan;
  /** The GitHub issue it's made from. */
  readonly github?: IssueGitHub;
}

/** What Claude wrote for a task made from a description (agent/task-drafter.ts). */
export interface IssueDraft {
  readonly title: string;
  readonly goal: string;
  /** What Claude found looking at the code (a draft written after a quick look). */
  readonly context?: string;
  readonly acceptance: readonly string[];
  readonly labels: readonly string[];
  readonly priority?: Priority;
}

export interface IssuePatch {
  readonly title?: string;
  readonly status?: IssueStatus;
  readonly priority?: Priority;
  /** null: no one. */
  readonly assignee?: Assignee | null;
  readonly labels?: readonly string[];
  readonly estimate?: number | null;
  readonly due?: string | null;
  /** null: not a sub-task any more. */
  readonly parent?: string | null;
}

export type Relation = 'blocked_by' | 'blocks' | 'related';

const MAX_TITLE = 200;
const MAX_SECTION = 20_000;
const MAX_COMMENT = 8_000;
const MAX_LABELS = 12;

const BoardFile = z.object({
  version: z.literal(1),
  // Renamed from autoTasks when it turned off by default (tasks come from plans now): the old key is ignored.
  worktreeTasks: z.boolean().default(false),
  projects: z.record(z.string(), z.object({ prefix: z.string().min(1).max(8), next: z.number().int().positive() })).default({}),
  issues: z.array(z.unknown()).default([]),
});

/** A task as saved: loosely checked (it's our own file), the rest filled in. */
const SavedIssue = z
  .object({
    id: z.string(),
    key: z.string(),
    number: z.number(),
    projectId: z.string(),
    title: z.string(),
    status: z.enum(ISSUE_STATUSES),
    priority: z.enum(PRIORITIES).default('none'),
    labels: z.array(z.string()).default([]),
    blockedBy: z.array(z.string()).default([]),
    related: z.array(z.string()).default([]),
    rank: z.number().default(0),
    brief: z.record(z.string(), z.string()).default({}),
    revisions: z.array(z.unknown()).default([]),
    worktrees: z.array(z.string()).default([]),
    proof: z.array(z.unknown()).default([]),
    activity: z.array(z.unknown()).default([]),
    createdAt: z.number(),
    updatedAt: z.number(),
    origin: z.enum(['manual', 'worktree', 'claude', 'plan', 'sync', 'github']).default('manual'),
  })
  .passthrough();

const short = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
const oneLine = (text: string, max: number): string => text.replace(/\s+/g, ' ').trim().slice(0, max);
const cleanLabels = (labels: readonly string[]): string[] => [...new Set(labels.map((l) => oneLine(l, 32).toLowerCase()).filter(Boolean))].slice(0, MAX_LABELS);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const actorWords = (a: Assignee): string => (a.kind === 'person' ? a.name : `${a.ownerName}’s Claude`);
const assigneeId = (a: Assignee | undefined): string => (!a ? '' : a.kind === 'person' ? `person:${a.id}` : `claude:${a.owner}`);
const statusText = (from: string, to: string): string => `moved this from ${from} to ${to}`;
const sameActor = (a: Actor, b: Actor): boolean => a.kind === b.kind && (a.kind === 'person' ? a.id === (b as typeof a).id : a.kind === 'claude' ? a.owner === (b as typeof a).owner : true);

/** A change to note in the activity; `was`/`now` let quick changes to one field become one line. */
interface Note {
  readonly kind: ActivityKind;
  readonly text: string;
  readonly assignee?: Assignee | null;
  readonly was?: string;
  readonly now?: string;
}

export class Board {
  private issues: Issue[] = [];
  private projects: Record<string, BoardProject> = {};
  private autoTasks = false;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** board.json couldn't be read nor moved aside: changes stay in memory rather than overwrite it. */
  private readOnly = false;
  private readonly now: () => number;

  constructor(private readonly deps: BoardDeps) {
    this.now = deps.now ?? Date.now;
    this.load();
    // Proof saved before files were kept (still in a worktree): kept now, while it's there.
    if (deps.dir) {
      const home = deps.dir;
      const before = this.issues;
      this.issues = this.issues.map((i) => {
        const proof = keepProofFiles(i.proof, i.id, home);
        return proof === i.proof ? i : { ...i, proof };
      });
      if (this.issues.some((i, n) => i !== before[n])) this.save();
    }
    deps.store.dispatch({ type: 'board_init', state: this.state() });
  }

  // ------------------------------------------------------------------ reading

  state(): BoardState {
    return { enabled: true, issues: this.issues, projects: this.projects, autoTasks: this.autoTasks };
  }

  list = (): readonly Issue[] => this.issues;

  /** A task by key ("BOB-12") or id; a clear error when there's none. */
  need(ref: string): Issue {
    const issue = findIssue(this.state(), ref);
    if (!issue) throw new Error(`There's no task ${ref}`);
    return issue;
  }

  get = (ref: string): Issue | undefined => findIssue(this.state(), ref);

  get autoTasksOn(): boolean {
    return this.autoTasks;
  }

  // ------------------------------------------------------------------ changing

  create(input: NewIssue, by: Actor, origin: Issue['origin'] = 'manual'): Issue {
    const title = oneLine(input.title, MAX_TITLE);
    if (!title) throw new Error('A task needs a title');
    const project = this.projectFor(input.projectId);
    const status = input.status ?? 'todo';
    const parent = input.parent ? this.need(input.parent) : undefined;
    if (parent && parent.projectId !== input.projectId) throw new Error('A sub-task belongs to its parent’s project');
    const blockers = (input.blockedBy ?? []).map((ref) => this.need(ref).id);
    const at = this.now();
    const number = project.next;

    const brief = Object.fromEntries(
      BRIEF_SECTIONS.flatMap((s) => {
        const text = input.brief?.[s]?.trim();
        return text ? [[s, text.slice(0, MAX_SECTION)]] : [];
      }),
    ) as Issue['brief'];
    const issue: Issue = {
      id: short('i'),
      key: `${project.prefix}-${number}`,
      number,
      projectId: input.projectId,
      title,
      ...(input.autoTitle ? { autoTitle: true } : {}),
      ...(input.drafting ? { drafting: true } : {}),
      status,
      priority: input.priority ?? 'none',
      labels: cleanLabels(input.labels ?? []),
      ...(input.estimate ? { estimate: input.estimate } : {}),
      ...(input.due && DAY.test(input.due) ? { due: input.due } : {}),
      ...(input.assignee ? { assignee: input.assignee } : {}),
      ...(parent ? { parent: parent.id } : {}),
      ...(input.plan ? { plan: input.plan } : {}),
      ...(input.github ? { github: input.github } : {}),
      blockedBy: [...new Set(blockers)],
      related: [],
      rank: this.lastRank(status),
      brief,
      revisions: [],
      worktrees: [],
      proof: [],
      activity: [this.entry(by, 'created', origin === 'worktree' ? 'opened this task for a new worktree' : origin === 'plan' ? 'created this task from a plan' : origin === 'sync' ? 'brought this task over' : origin === 'github' && input.github ? `made this task from GitHub issue #${input.github.number}` : 'created this task', undefined, at)],
      createdAt: at,
      updatedAt: at,
      createdBy: by,
      ...(isOpen(status) ? {} : { closedAt: at }),
      origin,
    };
    this.projects = { ...this.projects, [input.projectId]: { ...project, next: number + 1 } };
    this.issues = [...this.issues, issue];
    this.deps.store.dispatch({ type: 'board_meta', projects: this.projects, autoTasks: this.autoTasks });
    this.deps.store.dispatch({ type: 'board_issue', issue });
    this.save();
    return issue;
  }

  update(ref: string, patch: IssuePatch, by: Actor): Issue {
    let issue = this.need(ref);
    const notes: Note[] = [];
    const next: { -readonly [K in keyof Issue]?: Issue[K] } = {};
    if (patch.title !== undefined) {
      const title = oneLine(patch.title, MAX_TITLE);
      if (!title) throw new Error('A task needs a title');
      if (title !== issue.title) {
        next.title = title;
        notes.push({ kind: 'title', text: `renamed this to “${title}”`, was: issue.title, now: title });
      }
    }
    if (patch.status && patch.status !== issue.status) {
      notes.push({ kind: 'status', text: statusText(STATUS_INFO[issue.status].label, STATUS_INFO[patch.status].label), was: STATUS_INFO[issue.status].label, now: STATUS_INFO[patch.status].label });
      next.status = patch.status;
      next.rank = this.lastRank(patch.status);
      // It moved on (a person's choice, or every criterion settled): no longer held for its checks.
      if (issue.needsChecks) next.needsChecks = undefined;
    }
    if (patch.priority && patch.priority !== issue.priority) {
      next.priority = patch.priority;
      notes.push({ kind: 'priority', text: patch.priority === 'none' ? 'removed the priority' : `set the priority to ${PRIORITY_INFO[patch.priority].label}`, was: issue.priority, now: patch.priority });
    }
    if (patch.assignee !== undefined && !sameAssignee(patch.assignee ?? undefined, issue.assignee)) {
      next.assignee = patch.assignee ?? undefined;
      notes.push({ kind: 'assignee', text: patch.assignee ? `assigned this to ${actorWords(patch.assignee)}` : 'unassigned this', assignee: patch.assignee ?? null, was: assigneeId(issue.assignee), now: assigneeId(patch.assignee ?? undefined) });
    }
    if (patch.labels) {
      const labels = cleanLabels(patch.labels);
      if (labels.join('\0') !== issue.labels.join('\0')) {
        const added = labels.filter((l) => !issue.labels.includes(l));
        const removed = issue.labels.filter((l) => !labels.includes(l));
        next.labels = labels;
        notes.push({ kind: 'labels', text: [added.length ? `added ${added.join(', ')}` : '', removed.length ? `removed ${removed.join(', ')}` : ''].filter(Boolean).join(' and ') });
      }
    }
    if (patch.estimate !== undefined && (patch.estimate ?? undefined) !== issue.estimate) {
      next.estimate = patch.estimate ?? undefined;
      notes.push({ kind: 'estimate', text: patch.estimate ? `estimated this at ${patch.estimate} ${patch.estimate === 1 ? 'point' : 'points'}` : 'removed the estimate', was: String(issue.estimate ?? ''), now: String(patch.estimate ?? '') });
    }
    if (patch.due !== undefined && (patch.due ?? undefined) !== issue.due) {
      if (patch.due && !DAY.test(patch.due)) throw new Error('A due date looks like 2026-11-03');
      next.due = patch.due ?? undefined;
      notes.push({ kind: 'due', text: patch.due ? `set it due ${patch.due}` : 'removed the due date', was: issue.due ?? '', now: patch.due ?? '' });
    }
    if (patch.parent !== undefined && (patch.parent ?? undefined) !== issue.parent) {
      if (patch.parent) {
        const parent = this.need(patch.parent);
        if (parent.id === issue.id || this.isAncestor(issue.id, parent.id)) throw new Error('A task can’t be a sub-task of itself or of its own sub-tasks');
        if (parent.projectId !== issue.projectId) throw new Error('A sub-task belongs to its parent’s project');
        next.parent = parent.id;
        notes.push({ kind: 'parent', text: `made this a sub-task of ${parent.key}` });
      } else {
        next.parent = undefined;
        notes.push({ kind: 'parent', text: 'made this a task of its own' });
      }
    }
    if (!notes.length) return issue;
    const at = this.now();
    // One field changed again by the same person moments later: one line, from where it started.
    const last = issue.activity.at(-1);
    const only = notes.length === 1 ? notes[0]! : undefined;
    if (only?.was !== undefined && last && last.kind === only.kind && last.was !== undefined && sameActor(last.by, by) && at - last.at < COALESCE_MS) {
      const was = last.was;
      const back = was === only.now;
      const text = only.kind === 'status' ? statusText(was, only.now!) : only.text;
      const entries = back ? [] : [this.entry(by, only.kind, text, undefined, at, only.assignee, { was, now: only.now! })];
      return this.change(issue, next, entries, true, true);
    }
    issue = this.change(issue, next, notes.map((n) => this.entry(by, n.kind, n.text, undefined, at, n.assignee, n.was !== undefined ? { was: n.was, now: n.now! } : undefined)));
    return issue;
  }

  /**
   * Claude's draft for a task made from a description: its title (unless someone renamed it
   * meanwhile), goal and criteria where they're empty, labels added, a priority if it had none.
   * No draft: the first line stays the title, and what was said becomes the goal if it says more.
   */
  finishDraft(ref: string, draft: IssueDraft | undefined, by: Actor, said = ''): Issue {
    const issue = this.need(ref);
    if (!issue.drafting) return issue;
    if (!draft) {
      const text = said.trim().slice(0, MAX_SECTION);
      const more = text && text.replace(/\s+/g, ' ') !== issue.title && !issue.brief.goal;
      return this.change(issue, { drafting: undefined, ...(more ? { brief: { ...issue.brief, goal: text } } : {}) }, []);
    }
    const renamed = issue.activity.some((a) => a.kind === 'title');
    const title = oneLine(draft.title, MAX_TITLE);
    const brief = { ...issue.brief };
    if (!brief.goal && draft.goal.trim()) brief.goal = draft.goal.trim().slice(0, MAX_SECTION);
    if (!brief.context && draft.context?.trim()) brief.context = draft.context.trim().slice(0, MAX_SECTION);
    if (!brief.acceptance && draft.acceptance.length) brief.acceptance = draft.acceptance.map((a) => `- [ ] ${oneLine(a, 300)}`).join('\n');
    return this.change(
      issue,
      {
        drafting: undefined,
        ...(title && !renamed ? { title } : {}),
        brief,
        labels: cleanLabels([...issue.labels, ...draft.labels]),
        ...(draft.priority && issue.priority === 'none' ? { priority: draft.priority } : {}),
      },
      [this.entry(by, 'brief', 'wrote the title and goal')],
    );
  }

  /**
   * Where the task lives in another tracker, and what both sides looked like as they last agreed
   * (sync/sync.ts); undefined: not linked any more. Quiet but for the first link and an unlink.
   */
  setLink(ref: string, link: IssueLink | undefined, note?: string): Issue {
    const issue = this.need(ref);
    if (!link && !issue.link) return issue;
    const entries = note ? [this.entry({ kind: 'beluga' }, 'link', note)] : [];
    return this.change(issue, { link }, entries, false);
  }

  /**
   * The GitHub issue a task is for, and what Claude was last asked to do about it (see
   * core/issues); `note` goes in the activity ("asked Claude to investigate #12").
   */
  setGitHub(ref: string, github: IssueGitHub | undefined, by: Actor, note?: string): Issue {
    const issue = this.need(ref);
    const was = issue.github;
    if (was?.repo === github?.repo && was?.number === github?.number && was?.url === github?.url && was?.step === github?.step && was?.host === github?.host && was?.investigated === github?.investigated) return issue;
    return this.change(issue, { github }, note ? [this.entry(by, 'link', note)] : [], Boolean(note));
  }

  /** The plan (and milestone) a task belongs to; undefined: none any more. */
  setPlan(ref: string, link: IssuePlan | undefined, by: Actor, text?: string): Issue {
    const issue = this.need(ref);
    const same = issue.plan?.id === link?.id && issue.plan?.milestone === link?.milestone && issue.plan?.task === link?.task;
    if (same) return issue;
    return this.change(issue, { plan: link }, text ? [this.entry(by, 'plan', text)] : [], Boolean(text));
  }

  /** Drop a card in a column, between two others (the board): its status and its place. */
  move(ref: string, status: IssueStatus, between: { readonly before?: string; readonly after?: string }, by: Actor): Issue {
    let issue = this.need(ref);
    if (status !== issue.status) issue = this.update(issue.id, { status }, by);
    let before = between.before ? this.get(between.before) : undefined;
    let after = between.after ? this.get(between.after) : undefined;
    if (!before && !after) return issue;
    // Neighbours too close (or tied) to fit between: spread the column out first.
    if (before && after && !(after.rank - before.rank > 1e-6)) {
      this.respace(status, issue.id);
      before = this.get(before.id);
      after = this.get(after.id);
    }
    return this.change(this.need(issue.id), { rank: rankBetween(before?.rank, after?.rank) }, []);
  }

  /** Write one section of the brief (or add to it); the old text is kept as a revision. */
  editBrief(ref: string, section: BriefSection, text: string, by: Actor, opts: { readonly reason?: string; readonly mode?: 'replace' | 'append' } = {}): Issue {
    const issue = this.need(ref);
    if (!BRIEF_SECTIONS.includes(section)) throw new Error(`The brief has no section "${section}"`);
    const before = issue.brief[section] ?? '';
    const added = text.trim();
    const after = (opts.mode === 'append' && before ? `${before.trimEnd()}\n${added}` : added).slice(0, MAX_SECTION);
    if (after === before) return issue;
    const reason = opts.reason ? oneLine(opts.reason, 200) : undefined;
    const revision = { id: short('r'), at: this.now(), by, section, before, after, ...(reason ? { reason } : {}) };
    const brief = { ...issue.brief, [section]: after };
    if (!after) delete brief[section];
    const edited = this.change(issue, { brief, revisions: keepRevisions([...issue.revisions, revision]) }, [this.entry(by, 'brief', `${before ? 'updated' : 'wrote'} ${SECTION_INFO[section].label}${reason ? ` — ${reason}` : ''}`)]);
    return section === 'acceptance' ? this.checksSettled(edited) : edited;
  }

  /**
   * Kept out of review: a criterion is neither ticked nor explained (task_update refused it, or its
   * pull request opened). The board shows "Needs its checks" until they're settled.
   */
  holdForChecks(ref: string): Issue {
    const issue = this.need(ref);
    return issue.needsChecks ? issue : this.change(issue, { needsChecks: true }, [], false);
  }

  /** Every criterion ticked or explained now: no longer held, and a pull request that waited moves it to In Review. */
  private checksSettled(issue: Issue): Issue {
    if (!issue.needsChecks || unexplained(issue.brief.acceptance).length) return issue;
    const pr = issue.pr;
    const waiting = pr?.state === 'OPEN' && !pr.draft && pr.review !== 'CHANGES_REQUESTED' && (issue.status === 'backlog' || issue.status === 'todo' || issue.status === 'in_progress');
    if (!waiting) return this.change(issue, { needsChecks: undefined }, [], false);
    const beluga: Actor = { kind: 'beluga' };
    return this.change(issue, { needsChecks: undefined, status: 'in_review', rank: this.lastRank('in_review') }, [
      this.entry(beluga, 'status', `every criterion is ticked or explained: ${statusText(STATUS_INFO[issue.status].label, STATUS_INFO.in_review.label)}`),
    ]);
  }

  /** Put a section back the way a revision found it (that's a new revision too). */
  restoreRevision(ref: string, revisionId: string, by: Actor): Issue {
    const issue = this.need(ref);
    const revision = issue.revisions.find((r) => r.id === revisionId);
    if (!revision) throw new Error('That version isn’t kept any more');
    return this.editBrief(issue.id, revision.section, revision.before, by, { reason: 'restored an earlier version' });
  }

  /** A comment from a person, or a note from Claude (what it did, what it found). */
  comment(ref: string, text: string, by: Actor): Issue {
    const issue = this.need(ref);
    const body = text.trim().slice(0, MAX_COMMENT);
    if (!body) throw new Error('Nothing to say');
    return this.change(issue, {}, [this.entry(by, by.kind === 'claude' ? 'note' : 'comment', by.kind === 'claude' ? 'left a note' : 'commented', body)]);
  }

  /** Blockers both ways and related tasks; a loop of blockers is refused. */
  relate(ref: string, relation: Relation, otherRef: string, on: boolean, by: Actor): Issue {
    const issue = this.need(ref);
    const other = this.need(otherRef);
    if (other.id === issue.id) throw new Error('A task can’t be related to itself');
    if (relation === 'blocks') {
      this.relate(other.id, 'blocked_by', issue.id, on, by);
      return this.need(issue.id);
    }
    if (relation === 'related') {
      const has = issue.related.includes(other.id);
      if (has === on) return issue;
      const text = on ? `linked this to ${other.key}` : `unlinked ${other.key}`;
      const mine = this.change(issue, { related: on ? [...issue.related, other.id] : issue.related.filter((id) => id !== other.id) }, [this.entry(by, 'relation', text)]);
      const theirs = this.need(other.id);
      this.change(theirs, { related: on ? [...new Set([...theirs.related, issue.id])] : theirs.related.filter((id) => id !== issue.id) }, []);
      return mine;
    }
    const has = issue.blockedBy.includes(other.id);
    if (has === on) return issue;
    if (on && this.waitsOn(other.id, issue.id)) throw new Error(`${other.key} already waits on ${issue.key}: that would be a loop`);
    const mine = this.change(issue, { blockedBy: on ? [...issue.blockedBy, other.id] : issue.blockedBy.filter((id) => id !== other.id) }, [this.entry(by, 'relation', on ? `marked this as blocked by ${other.key}` : `removed ${other.key} as a blocker`)]);
    this.change(this.need(other.id), {}, [this.entry(by, 'relation', on ? `marked this as blocking ${issue.key}` : `${issue.key} no longer waits on this`)]);
    return mine;
  }

  addProof(ref: string, proof: Omit<Proof, 'id' | 'at' | 'by'>, by: Actor): Issue {
    const issue = this.need(ref);
    const title = oneLine(proof.title, 120);
    if (!title) throw new Error('Proof needs a title');
    const { from: _, gone: __, ...given } = proof;
    const made: Proof = { ...given, title, id: short('p'), at: this.now(), by };
    // Its file is copied now, so it outlives the worktree it was made in.
    const item = this.deps.dir ? keepProofFile(made, issue.id, this.deps.dir) : made;
    const kept = [...issue.proof, item];
    if (this.deps.dir) for (const old of kept.slice(0, -KEEP_PROOF)) dropKeptFile(this.deps.dir, old.path);
    return this.change(issue, { proof: kept.slice(-KEEP_PROOF) }, [this.entry(by, 'proof', `added proof: ${title}`)]);
  }

  removeProof(ref: string, proofId: string, by: Actor): Issue {
    const issue = this.need(ref);
    const gone = issue.proof.find((p) => p.id === proofId);
    if (!gone) return issue;
    if (this.deps.dir) dropKeptFile(this.deps.dir, gone.path);
    return this.change(issue, { proof: issue.proof.filter((p) => p.id !== proofId) }, [this.entry(by, 'proof', `removed proof: ${gone.title}`)]);
  }

  /**
   * Keep proof files that are still somewhere else (`within`: only those in this folder, a
   * worktree about to be archived or deleted): copied into ~/.beluga/proof, and those whose file
   * is gone marked so. Quiet: no activity, the task's time untouched. → how many proofs changed.
   */
  keepProofs(within?: string): number {
    const home = this.deps.dir;
    if (!home) return 0;
    let n = 0;
    for (const issue of this.issues) {
      const proof = keepProofFiles(issue.proof, issue.id, home, within);
      if (proof === issue.proof) continue;
      n += proof.filter((p, i) => p !== issue.proof[i]).length;
      this.change(issue, { proof }, [], false);
    }
    return n;
  }

  // ------------------------------------------------------------------ the archive

  /**
   * To the Archive: off the board and out of Claude's lists, its words and history kept, its proof
   * files let go (screenshots kept as small JPEGs, see letGoProofFile). Only finished tasks (Done,
   * Canceled) go; a parent takes its finished sub-tasks along.
   */
  archive(ref: string, by: Actor): Issue {
    const issue = this.need(ref);
    if (isArchived(issue)) return issue;
    if (isOpen(issue.status)) throw new Error(`${issue.key} isn’t finished: only Done or Canceled tasks go to the Archive`);
    const home = this.deps.dir;
    const proof = home ? issue.proof.map((p) => letGoProofFile(p, home)) : issue.proof;
    const archived = this.change(issue, { archivedAt: this.now(), proof }, [this.entry(by, 'status', 'archived this')], false);
    for (const kid of this.issues.filter((i) => i.parent === issue.id && !isOpen(i.status) && !isArchived(i))) this.archive(kid.id, by);
    return archived;
  }

  /** Every Done task to the Archive (in one project, or all of them). → how many went. */
  archiveDone(by: Actor, projectId?: string): number {
    const done = this.issues.filter((i) => i.status === 'done' && !isArchived(i) && (!projectId || i.projectId === projectId));
    for (const issue of done) this.archive(issue.id, by);
    return done.length;
  }

  /** Back on the board from the Archive (its proof files stay let go). */
  unarchive(ref: string, by: Actor): Issue {
    const issue = this.need(ref);
    if (!isArchived(issue)) return issue;
    return this.change(issue, { archivedAt: undefined }, [this.entry(by, 'status', 'brought this back from the Archive')]);
  }

  /** Delete every archived task for good (in one project, or all of them). → how many went. */
  emptyArchive(projectId?: string): number {
    const gone = this.issues.filter((i) => isArchived(i) && (!projectId || i.projectId === projectId));
    for (const issue of gone) this.remove(issue.id);
    return gone.length;
  }

  /** Delete a task: its sub-tasks become tasks of their own, and nothing waits on it any more. */
  remove(ref: string): void {
    const issue = this.need(ref);
    if (this.deps.dir) dropProofFolder(this.deps.dir, issue.id);
    this.issues = this.issues.filter((i) => i.id !== issue.id);
    this.deps.store.dispatch({ type: 'board_remove', id: issue.id });
    for (const other of this.issues) {
      const touched = other.parent === issue.id || other.blockedBy.includes(issue.id) || other.related.includes(issue.id);
      if (!touched) continue;
      this.change(other, { ...(other.parent === issue.id ? { parent: undefined } : {}), blockedBy: other.blockedBy.filter((id) => id !== issue.id), related: other.related.filter((id) => id !== issue.id) }, [], false);
    }
    this.save();
  }

  // ------------------------------------------------------------------ worktrees and pull requests

  /**
   * A worktree is doing this task now. One task per worktree, unless `shared`: a plan milestone's
   * one Claude does all of its tasks in one worktree (see plans/pilot.ts), so each of them links it.
   */
  linkWorktree(ref: string, workspaceId: string, info: { readonly branch?: string; readonly name?: string; readonly shared?: boolean }, by: Actor): Issue {
    const issue = this.need(ref);
    if (!info.shared) for (const other of this.issues) if (other.id !== issue.id && other.worktrees.includes(workspaceId)) this.change(other, { worktrees: other.worktrees.filter((w) => w !== workspaceId) }, []);
    if (issue.worktrees.at(-1) === workspaceId) return issue;
    return this.change(issue, { worktrees: [...issue.worktrees.filter((w) => w !== workspaceId), workspaceId], ...(info.branch ? { branch: info.branch } : {}), worktreeGone: undefined, carriedBy: undefined }, [this.entry(by, 'worktree', info.name ? `${info.shared ? 'joined' : 'started'} worktree ${info.name}` : 'started a worktree')]);
  }

  /**
   * Claude moved this task along from a worktree that isn't doing it (one doing a bigger task, or a
   * list of asks): that worktree carries it now, so its pull request merging makes it Done too. A
   * task with a worktree of its own (`live`: still there) keeps following that one.
   */
  carry(ref: string, ws: { readonly id: string; readonly branch?: string; readonly name?: string }, live: (workspaceId: string) => boolean): Issue {
    const issue = this.need(ref);
    const own = issue.worktrees.at(-1);
    if (own === ws.id || issue.carriedBy === ws.id || (own && live(own))) return issue;
    return this.change(issue, { carriedBy: ws.id, ...(ws.branch ? { branch: ws.branch } : {}) }, [this.entry({ kind: 'beluga' }, 'worktree', `its work is being done in worktree ${ws.name ?? ws.id}`)], false);
  }

  /** The worktree was renamed (a small model named it): a task titled after it follows. */
  retitle(ref: string, title: string): Issue {
    const issue = this.need(ref);
    const clean = oneLine(title, MAX_TITLE);
    if (!issue.autoTitle || !clean || clean === issue.title) return issue;
    return this.change(issue, { title: clean, autoTitle: true }, []);
  }

  /** Done with the question its worktree going away raised: Canceled, back to the Backlog, or keep it as it is. */
  settleGone(ref: string, next: 'canceled' | 'backlog' | 'keep', by: Actor): Issue {
    const issue = this.need(ref);
    const settled = this.change(issue, { worktreeGone: undefined }, []);
    return next === 'keep' ? settled : this.update(settled.id, { status: next }, by);
  }

  /** The worktree went away (archived or deleted) — or came back. */
  worktreeGone(workspaceId: string, gone: boolean, how: 'archived' | 'deleted' | 'restored'): void {
    for (const issue of this.issues) {
      if (issue.worktrees.at(-1) !== workspaceId) continue;
      // Merged into Plan: its work is in the plan's branch, so its worktree going away is expected.
      const ask = gone && isOpen(issue.status) && issue.status !== 'in_plan';
      // A deleted worktree can't be opened again: it's no longer the task's.
      const worktrees = how === 'deleted' ? issue.worktrees.filter((w) => w !== workspaceId) : issue.worktrees;
      this.change(issue, { worktreeGone: ask || undefined, worktrees }, [this.entry({ kind: 'beluga' }, 'worktree', `its worktree was ${how}`)]);
    }
  }

  /** The worktree's pull request as the workbench saw it: kept on the task, and the task's status follows it. */
  prChanged(workspaceId: string, pr: IssuePr | undefined): void {
    for (const issue of this.issues) {
      // Only the worktree doing it now (or carrying it): an older one's pull request is history.
      if (!followsWorktree(issue, workspaceId) || !pr) continue;
      const before = issue.pr;
      const same = before && before.number === pr.number && before.state === pr.state && before.checks === pr.checks && before.review === pr.review && before.draft === pr.draft && before.title === pr.title;
      if (same) continue;
      const beluga: Actor = { kind: 'beluga' };
      const notes: Activity[] = [];
      let status: IssueStatus | undefined;
      if (!before || before.number !== pr.number) notes.push(this.entry(beluga, 'pr', `opened pull request #${pr.number}`));
      if (pr.state === 'MERGED' && before?.state !== 'MERGED') {
        notes.push(this.entry(beluga, 'pr', `pull request #${pr.number} was merged`));
        if (issue.status !== 'canceled') status = 'done';
      } else if (pr.state === 'CLOSED' && before?.state !== 'CLOSED') {
        notes.push(this.entry(beluga, 'pr', `pull request #${pr.number} was closed without merging`));
      } else if (pr.state === 'OPEN') {
        if (pr.review === 'CHANGES_REQUESTED' && before?.review !== 'CHANGES_REQUESTED') {
          notes.push(this.entry(beluga, 'pr', 'changes were requested on the pull request'));
          if (issue.status === 'in_review') status = 'in_progress';
        } else if (pr.review === 'APPROVED' && before?.review !== 'APPROVED') notes.push(this.entry(beluga, 'pr', 'the pull request was approved'));
        if (pr.checks === 'failing' && before?.checks !== 'failing') notes.push(this.entry(beluga, 'pr', 'checks are failing'));
        if (!status && pr.review !== 'CHANGES_REQUESTED' && (issue.status === 'backlog' || issue.status === 'todo' || issue.status === 'in_progress') && (!before || before.number !== pr.number || pr.draft !== before.draft) && !pr.draft) status = 'in_review';
      }
      // Not to review while a criterion is neither ticked nor explained: held until it is (see checksSettled).
      const open = status === 'in_review' ? unexplained(issue.brief.acceptance) : [];
      if (open.length) {
        status = undefined;
        notes.push(this.entry(beluga, 'pr', `kept this out of In Review: ${open.length === 1 ? 'a criterion is' : `${open.length} criteria are`} neither ticked nor explained (${open.map((c) => `“${c.text}”`).join('; ')})`));
      }
      if (status && status !== issue.status) notes.push(this.entry(beluga, 'status', `moved this from ${STATUS_INFO[issue.status].label} to ${STATUS_INFO[status].label}`));
      const moved = status && status !== issue.status;
      this.change(issue, { pr, ...(moved ? { status, rank: this.lastRank(status!), needsChecks: undefined } : {}), ...(open.length ? { needsChecks: true } : {}) }, notes);
    }
  }

  /**
   * Its branch's pull request, found merged after its worktree stopped being watched (archived or
   * gone, see BoardWork.sweepShipped): Done, like a merge seen live.
   */
  branchShipped(ref: string, pr: IssuePr): Issue {
    const issue = this.need(ref);
    if (pr.state !== 'MERGED' || !isOpen(issue.status) || isArchived(issue)) return issue;
    const beluga: Actor = { kind: 'beluga' };
    return this.change(issue, { pr, status: 'done', rank: this.lastRank('done'), needsChecks: undefined, worktreeGone: undefined }, [
      this.entry(beluga, 'pr', `pull request #${pr.number} was merged`),
      this.entry(beluga, 'status', statusText(STATUS_INFO[issue.status].label, STATUS_INFO.done.label)),
    ]);
  }

  /** The worktree was merged into the project's main folder here. */
  worktreeMerged(workspaceId: string): void {
    for (const issue of this.issues) {
      if (!followsWorktree(issue, workspaceId) || issue.status === 'done' || issue.status === 'canceled') continue;
      const beluga: Actor = { kind: 'beluga' };
      this.change(issue, { status: 'done' }, [this.entry(beluga, 'worktree', 'its worktree was merged into main'), this.entry(beluga, 'status', `moved this from ${STATUS_INFO[issue.status].label} to Done`)]);
    }
  }

  /**
   * Where a plan's work is now: merged into the plan's branch (Merged into Plan), or into main with the
   * plan (Done). `text` says how ("merged into plan/x", "merged into main via #12").
   */
  planMoved(ref: string, status: 'in_plan' | 'done', text: string): Issue {
    const issue = this.need(ref);
    if (issue.status === status || issue.status === 'canceled') return issue;
    const beluga: Actor = { kind: 'beluga' };
    return this.change(issue, { status, rank: this.lastRank(status) }, [this.entry(beluga, 'plan', text), this.entry(beluga, 'status', `moved this from ${STATUS_INFO[issue.status].label} to ${STATUS_INFO[status].label}`)]);
  }

  // ------------------------------------------------------------------ team boards (core/team/board-sync.ts)

  /**
   * A teammate's task, new here: it keeps its id (the same on every Mac in the team) and gets a
   * key of this project's own. Its activity is what the team has of it; nothing is added here.
   */
  adoptTeam(input: Omit<Issue, 'key' | 'number' | 'rank' | 'revisions' | 'worktrees' | 'proof' | 'updatedAt'>): Issue {
    if (this.issues.some((i) => i.id === input.id)) return this.need(input.id);
    const project = this.projectFor(input.projectId);
    const number = project.next;
    const issue: Issue = { ...input, key: `${project.prefix}-${number}`, number, rank: this.lastRank(input.status), revisions: [], worktrees: [], proof: [], updatedAt: this.now(), ...(isOpen(input.status) ? {} : { closedAt: input.closedAt ?? this.now() }) };
    this.projects = { ...this.projects, [input.projectId]: { ...project, next: number + 1 } };
    this.issues = [...this.issues, issue];
    this.deps.store.dispatch({ type: 'board_meta', projects: this.projects, autoTasks: this.autoTasks });
    this.deps.store.dispatch({ type: 'board_issue', issue });
    this.save();
    return issue;
  }

  /**
   * A teammate's change to a task, as the team settled it: the fields that won, activity entries to
   * add (and entries its author took back, a coalesced line), and who wrote the brief sections
   * (they're kept as revisions, so Restore This works on what came from a teammate too).
   */
  applyTeam(ref: string, patch: Partial<Pick<Issue, 'title' | 'status' | 'priority' | 'labels' | 'estimate' | 'due' | 'assignee' | 'parent' | 'blockedBy' | 'related' | 'github'>> & { readonly brief?: Partial<Record<BriefSection, string>> }, add: readonly Activity[], drop: readonly string[], by: Actor): Issue {
    const issue = this.need(ref);
    const { brief: briefPatch, ...fields } = patch;
    const next: Record<string, unknown> = { ...fields };
    if (fields.status && fields.status !== issue.status) {
      next.rank = this.lastRank(fields.status);
      if (issue.needsChecks) next.needsChecks = undefined;
    }
    if (briefPatch) {
      const brief = { ...issue.brief } as Record<BriefSection, string>;
      const revisions = [...issue.revisions];
      for (const [section, text] of Object.entries(briefPatch) as Array<[BriefSection, string]>) {
        const before = issue.brief[section] ?? '';
        if (before === text) continue;
        revisions.push({ id: short('r'), at: this.now(), by, section, before, after: text, reason: 'from a teammate' });
        if (text) brief[section] = text;
        else delete brief[section];
      }
      next.brief = brief;
      next.revisions = keepRevisions(revisions);
    }
    const gone = new Set(drop);
    const kept = gone.size ? issue.activity.filter((a) => !gone.has(a.id)) : issue.activity;
    const known = new Set(kept.map((a) => a.id));
    const activity = [...kept, ...add.filter((a) => !known.has(a.id))].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    return this.change({ ...issue, activity: [] }, next as Partial<Issue>, activity);
  }

  // ------------------------------------------------------------------ settings

  setAutoTasks(on: boolean): void {
    this.autoTasks = on;
    this.deps.store.dispatch({ type: 'board_meta', projects: this.projects, autoTasks: on });
    this.save();
  }

  /** Keys start with this from now on (tasks keep the keys they have). */
  setPrefix(projectId: string, prefix: string): void {
    const clean = prefix.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (clean.length < 2) throw new Error('A prefix is 2 to 6 letters or digits');
    // Old keys stay as they were: a prefix another project's tasks still use is taken too.
    if (Object.entries(this.projects).some(([id, p]) => id !== projectId && p.prefix === clean) || this.issues.some((i) => i.projectId !== projectId && i.key.startsWith(`${clean}-`))) throw new Error(`Another project's keys already start with ${clean}`);
    const project = this.projectFor(projectId);
    this.projects = { ...this.projects, [projectId]: { ...project, prefix: clean } };
    this.deps.store.dispatch({ type: 'board_meta', projects: this.projects, autoTasks: this.autoTasks });
    this.save();
  }

  /** Write anything waiting now (on the way out). */
  flush(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.write();
  }

  // ------------------------------------------------------------------ inside

  private projectFor(projectId: string): BoardProject {
    const known = this.projects[projectId];
    if (known) return known;
    const name = this.deps.projectName(projectId);
    if (!name) throw new Error('That project isn’t here');
    const taken = new Set([...Object.values(this.projects).map((p) => p.prefix), ...this.issues.map((i) => i.key.replace(/-\d+$/, ''))]);
    return { prefix: prefixFor(name, taken), next: 1 };
  }

  private entry(by: Actor, kind: ActivityKind, text: string, body?: string, at = this.now(), assignee?: Assignee | null, change?: { readonly was: string; readonly now: string }): Activity {
    return { id: short('a'), at, by, kind, text, ...(body ? { body } : {}), ...(assignee !== undefined ? { assignee } : {}), ...(change ?? {}) };
  }

  /** Replace a task with changes and activity (`replaceLast`: instead of its last line), tell every screen, and save. */
  private change(issue: Issue, patch: Partial<{ -readonly [K in keyof Issue]: Issue[K] }>, activity: readonly Activity[], touch = true, replaceLast = false): Issue {
    const at = this.now();
    const merged: Record<string, unknown> = { ...issue, ...patch };
    // undefined in a patch removes the field (no "key": undefined in the file).
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete merged[k];
    const status = (patch.status ?? issue.status) as IssueStatus;
    if (patch.status) {
      if (isOpen(status)) delete merged.closedAt;
      else merged.closedAt = at;
    }
    if (patch.title !== undefined && issue.autoTitle && !('autoTitle' in patch)) delete merged.autoTitle;
    const next = { ...(merged as unknown as Issue), activity: [...(replaceLast ? issue.activity.slice(0, -1) : issue.activity), ...activity].slice(-KEEP_ACTIVITY), updatedAt: touch ? at : issue.updatedAt };
    this.issues = this.issues.map((i) => (i.id === issue.id ? next : i));
    this.deps.store.dispatch({ type: 'board_issue', issue: next });
    this.save();
    if (status === 'done' && issue.status !== 'done') this.doneWithParent(next);
    return next;
  }

  /** A task reached Done: its sub-tasks still open go with it (theirs with them, in turn). */
  private doneWithParent(parent: Issue): void {
    const beluga: Actor = { kind: 'beluga' };
    for (const kid of this.issues.filter((i) => i.parent === parent.id && isOpen(i.status))) {
      this.change(kid, { status: 'done', rank: this.lastRank('done'), needsChecks: undefined, worktreeGone: undefined }, [this.entry(beluga, 'status', `done with its parent ${parent.key}: ${statusText(STATUS_INFO[kid.status].label, STATUS_INFO.done.label)}`)]);
    }
  }

  /** A rank after every task in a status (across projects: the board's columns mix them). */
  private lastRank(status: IssueStatus): number {
    const ranks = this.issues.filter((i) => i.status === status).map((i) => i.rank);
    return rankBetween(ranks.length ? Math.max(...ranks) : undefined, undefined);
  }

  /** Every task in a status spread out again, 1000 apart, keeping their order. */
  private respace(status: IssueStatus, skip: string): void {
    const column = this.issues.filter((i) => i.status === status && i.id !== skip).sort(byRank);
    column.forEach((issue, n) => this.change(issue, { rank: (n + 1) * 1000 }, [], false));
  }

  /** Whether `id` waits (directly or through others) on `target`. */
  private waitsOn(id: string, target: string, seen = new Set<string>()): boolean {
    if (id === target) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const issue = this.issues.find((i) => i.id === id);
    return Boolean(issue?.blockedBy.some((b) => this.waitsOn(b, target, seen)));
  }

  /** Whether `ancestor` is above `id` in the sub-task tree. */
  private isAncestor(ancestor: string, id: string): boolean {
    let at = this.issues.find((i) => i.id === id)?.parent;
    for (let hops = 0; at && hops <= this.issues.length; hops++) {
      if (at === ancestor) return true;
      at = this.issues.find((i) => i.id === at)?.parent;
    }
    return false;
  }

  private load(): void {
    if (!this.deps.dir) return;
    const file = path.join(this.deps.dir, 'board.json');
    if (!existsSync(file)) return;
    const raw = renamedActors(readJson(file));
    const parsed = BoardFile.safeParse(raw);
    if (!parsed.success) {
      // Never written over: kept aside (a newer Beluga's board, or a damaged file), and this one starts fresh.
      this.setAside(file, 'unreadable');
      return;
    }
    this.autoTasks = parsed.data.worktreeTasks;
    this.projects = parsed.data.projects;
    const dropped: unknown[] = [];
    this.issues = parsed.data.issues.flatMap((item) => {
      const r = SavedIssue.safeParse(item);
      if (!r.success) dropped.push(item);
      if (!r.success) return [];
      // A draft cut short by a restart: the first line stays the title.
      const { drafting: _, ...issue } = r.data as unknown as Issue;
      return [issue as Issue];
    });
    // Tasks that don't read any more are kept beside it, not lost.
    if (dropped.length) {
      try {
        writeJson(path.join(this.deps.dir, `board.dropped-${this.now()}.json`), dropped);
      } catch {
        // Nowhere to keep them: the board goes on without them.
      }
    }
  }

  private setAside(file: string, why: string): void {
    try {
      renameSync(file, `${file}.${why}-${this.now()}`);
    } catch {
      // Can't move it: don't write over it either.
      this.readOnly = true;
    }
  }

  private save(): void {
    if (!this.deps.dir || this.readOnly || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.write();
    }, this.deps.saveDelayMs ?? 300);
    this.saveTimer.unref?.();
  }

  private write(): void {
    if (!this.deps.dir) return;
    try {
      writeJson(path.join(this.deps.dir, 'board.json'), { version: 1, worktreeTasks: this.autoTasks, projects: this.projects, issues: this.issues });
    } catch {
      // A full disk or a permission problem: the next change tries again.
    }
  }
}

/** The last KEEP_REVISIONS versions of each section (a busy section doesn't push out another's history). */
function keepRevisions(revisions: readonly BriefRevision[]): BriefRevision[] {
  const seen = new Map<string, number>();
  const kept: BriefRevision[] = [];
  for (let i = revisions.length - 1; i >= 0; i--) {
    const r = revisions[i]!;
    const n = seen.get(r.section) ?? 0;
    if (n >= KEEP_REVISIONS) continue;
    seen.set(r.section, n + 1);
    kept.push(r);
  }
  return kept.reverse();
}

/** The worktree whose pull request and merge move this task: the one doing it now, or one carrying it. */
const followsWorktree = (issue: Issue, workspaceId: string): boolean => issue.worktrees.at(-1) === workspaceId || issue.carriedBy === workspaceId;

function sameAssignee(a: Assignee | undefined, b: Assignee | undefined): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && (a.kind === 'person' ? a.id === (b as typeof a).id : a.owner === (b as Extract<Assignee, { kind: 'claude' }>).owner);
}
