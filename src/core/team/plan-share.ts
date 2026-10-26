import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { readJson, writeJson } from '../../net/mesh/files.js';
import { PlanOpSchema } from '../../ipc/plans-api.js';
import type { PlanOp } from '../plans/edit.js';
import { type Plan, type PlanBody, planTitle, shownBody } from '../plans/model.js';
import { clean } from '../store.js';
import type { Action } from '../store.js';
import type { MyPlanShare, PlanReview, PlanReviewKind, SharedPlan, TeamState } from './model.js';
import type { TeamMsg } from './protocol.js';
import type { TeamBoards, TeamLink, TeamPart } from './service.js';

/**
 * Plan drafts shared with teammates (BLG-225). A plan stays yours until you share it (its •••
 * › Share Plan with Team). Teammates then see its draft (or what was approved) read-only, with its
 * milestones and tasks, and can comment, suggest changes (the plan's own edit ops) or approve.
 * You're notified, and apply a suggestion in one click (it goes in as your edit). Every change to
 * the plan reaches them as it happens; Stop Sharing takes it back.
 *
 * File: `team-plans.json` (what you share and its reviews, and what teammates share with you).
 */

export interface PlanShareDeps {
  /** Your edit to a plan (plans.edit: the same as editing its outline). */
  readonly edit: (planId: string, ops: readonly PlanOp[]) => void;
  readonly dir: string | null;
}

const newId = (): string => `rv_${randomBytes(9).toString('base64url')}`;
const keyOf = (owner: string, id: string): string => `${owner}/${id}`;
const MAX_REVIEWS = 200;

export class TeamPlans implements TeamPart {
  private shares: Record<string, MyPlanShare> = {};
  private received: Record<string, SharedPlan> = {};
  /** What each teammate last got of a plan (so an unchanged plan isn't sent again). */
  private readonly sent = new Map<string, string>();

  constructor(
    private readonly team: TeamBoards,
    private readonly deps: PlanShareDeps,
  ) {
    this.load();
  }

  private plan(id: string): Plan | undefined {
    return this.team.deps.store.getState().plans.plans.find((p) => p.id === id);
  }

  // ------------------------------------------------------------------ yours

  /** Share Plan with Team (on), or Stop Sharing (off). */
  share(planId: string, on: boolean): void {
    const plan = this.plan(planId);
    if (!plan) throw new Error('That plan isn’t here any more');
    if (!on) {
      const had = this.shares[planId];
      if (!had) return;
      for (const link of this.team.linksOf(plan.projectId)) if (had.peers.includes(link.peerId)) this.team.send(link.peerId, { k: 'plan_gone', link: link.id, id: planId }, `plan:${planId}`);
      delete this.shares[planId];
      this.save();
      this.team.publish();
      this.team.deps.toast?.(`Stopped sharing “${planTitle(plan)}” with your team`, 'success');
      return;
    }
    const links = this.team.linksOf(plan.projectId);
    if (!links.length) throw new Error('This project isn’t worked on as a team yet: team up with a friend on its repository first');
    if (!shownBody(plan)) throw new Error('There’s nothing in this plan to share yet');
    const able = links.filter((l) => !this.team.cannot(l.peerId, 'team.plans'));
    if (!able.length) throw new Error(this.team.cannot(links[0]!.peerId, 'team.plans')!);
    this.shares[planId] = { planId, peers: able.map((l) => l.peerId), reviews: this.shares[planId]?.reviews ?? [] };
    this.save();
    this.push(plan, true);
    this.team.publish();
    const missed = links.filter((l) => !able.includes(l)).map((l) => this.team.cannot(l.peerId, 'team.plans')!);
    this.team.deps.toast?.(missed.length ? missed[0]! : `Shared “${planTitle(plan)}” with ${able.map((l) => this.team.nameOf(l.peerId)).join(', ')}`, missed.length ? 'warn' : 'success');
  }

  /** Put a teammate's suggested changes into the plan (as your edit). */
  apply(planId: string, reviewId: string): void {
    const review = this.reviewOf(planId, reviewId);
    if (review.kind !== 'suggest' || !review.ops?.length) throw new Error('That isn’t a suggested change');
    if (review.settled) throw new Error(review.settled === 'applied' ? 'That change is in already' : 'You set that one aside');
    const ops = review.ops.flatMap((o) => {
      const r = PlanOpSchema.safeParse(o);
      return r.success ? [r.data as PlanOp] : [];
    });
    if (!ops.length) throw new Error('Nothing in that suggestion can be applied');
    this.deps.edit(planId, ops);
    this.settle(planId, reviewId, 'applied');
  }

  /** Set a suggestion aside. */
  dismiss(planId: string, reviewId: string): void {
    this.reviewOf(planId, reviewId);
    this.settle(planId, reviewId, 'dismissed');
  }

  private reviewOf(planId: string, reviewId: string): PlanReview {
    const r = this.shares[planId]?.reviews.find((x) => x.id === reviewId);
    if (!r) throw new Error('That review isn’t here any more');
    return r;
  }

  private settle(planId: string, reviewId: string, how: 'applied' | 'dismissed'): void {
    const share = this.shares[planId]!;
    this.shares[planId] = { ...share, reviews: share.reviews.map((r) => (r.id === reviewId ? { ...r, settled: how } : r)) };
    this.save();
    const plan = this.plan(planId);
    if (plan) this.push(plan, false);
    this.team.publish();
  }

  /** The plan as it is now, to every teammate it's shared with (only when it changed for them). */
  private push(plan: Plan, force: boolean): void {
    const share = this.shares[plan.id];
    const body = shownBody(plan);
    if (!share || !body) return;
    const msg = { id: plan.id, title: planTitle(plan).slice(0, 200), body: wire(body), rev: plan.draftRev, status: plan.status, reviews: share.reviews.slice(-MAX_REVIEWS) as PlanReview[] };
    const sig = JSON.stringify(msg);
    for (const link of this.team.linksOf(plan.projectId)) {
      if (!share.peers.includes(link.peerId)) continue;
      const k = `${link.peerId}:${plan.id}`;
      if (!force && this.sent.get(k) === sig) continue;
      this.sent.set(k, sig);
      this.team.send(link.peerId, { k: 'plan', link: link.id, plan: msg as Extract<TeamMsg, { k: 'plan' }>['plan'] }, `plan:${plan.id}`);
    }
  }

  // ------------------------------------------------------------------ theirs

  /** Your word on a plan a teammate shared: a comment, an approval, or changes you suggest. */
  review(owner: string, planId: string, input: { readonly kind: PlanReviewKind; readonly text?: string; readonly ops?: readonly unknown[] }): PlanReview {
    const plan = this.received[keyOf(owner, planId)];
    if (!plan) throw new Error('That plan isn’t shared with you any more');
    const link = this.team.linksOf(plan.projectId).find((l) => l.peerId === owner);
    if (!link) throw new Error('You’re no longer a team with them');
    const text = input.text?.trim().slice(0, 8000);
    if (input.kind === 'comment' && !text) throw new Error('Nothing to say');
    if (input.kind === 'suggest' && !input.ops?.length) throw new Error('Suggest at least one change');
    const ops = input.kind === 'suggest' ? (input.ops ?? []).filter((o) => PlanOpSchema.safeParse(o).success) : undefined;
    if (input.kind === 'suggest' && !ops?.length) throw new Error('Those changes don’t fit the plan');
    const review: PlanReview = { id: newId(), by: this.team.self, name: this.selfName(), kind: input.kind, ...(text ? { text } : {}), ...(ops ? { ops } : {}), rev: plan.rev, at: this.team.now() };
    this.team.send(owner, { k: 'review', link: link.id, plan: planId, review: { id: review.id, kind: review.kind, ...(text ? { text } : {}), ...(ops ? { ops: [...ops] } : {}), rev: review.rev, at: review.at } });
    // Shown at once here; the owner's next copy has it for everyone.
    this.received[keyOf(owner, planId)] = { ...plan, reviews: [...plan.reviews, review].slice(-MAX_REVIEWS) };
    this.save();
    this.team.publish();
    return review;
  }

  private selfName(): string {
    const st = this.team.deps.store.getState();
    return st.network.self?.name ?? st.self?.name ?? 'Your teammate';
  }

  // ------------------------------------------------------------------ TeamPart

  receive(from: string, m: TeamMsg): boolean {
    if (m.k !== 'plan' && m.k !== 'plan_gone' && m.k !== 'review') return false;
    const link = this.team.linkById(m.link);
    if (!link || link.peerId !== from) return true;
    if (m.k === 'plan') this.onPlan(link, m.plan);
    else if (m.k === 'plan_gone') this.forget(from, m.id);
    else this.onReview(link, m.plan, m.review);
    return true;
  }

  private onPlan(link: TeamLink, p: Extract<TeamMsg, { k: 'plan' }>['plan']): void {
    const key = keyOf(link.peerId, p.id);
    const before = this.received[key];
    const ownerName = this.team.nameOf(link.peerId);
    this.received[key] = {
      owner: link.peerId,
      ownerName,
      id: p.id,
      projectId: link.projectId,
      title: clean(p.title),
      body: p.body as unknown as PlanBody,
      rev: p.rev,
      status: p.status,
      reviews: p.reviews.map((r) => ({ ...r, name: clean(r.name), ...(r.text ? { text: clean(r.text) } : {}) })),
      updatedAt: this.team.now(),
    };
    this.save();
    this.team.publish();
    if (!before) this.team.deps.notify?.({ kind: 'needsYou', tag: 'plan', title: `${ownerName} shared the plan “${clean(p.title)}” with you`, body: 'Read it, comment, suggest changes or approve.', key: `team-plan:${link.peerId}:${p.id}` });
  }

  private forget(owner: string, id: string): void {
    const key = keyOf(owner, id);
    if (!this.received[key]) return;
    delete this.received[key];
    this.save();
    this.team.publish();
  }

  private onReview(link: TeamLink, planId: string, r: Extract<TeamMsg, { k: 'review' }>['review']): void {
    const share = this.shares[planId];
    const plan = this.plan(planId);
    if (!share || !plan || plan.projectId !== link.projectId || !share.peers.includes(link.peerId)) return;
    if (share.reviews.some((x) => x.id === r.id)) return;
    const name = this.team.nameOf(link.peerId);
    const review: PlanReview = { ...r, ...(r.text ? { text: clean(r.text) } : {}), by: link.peerId, name, at: this.team.now() };
    this.shares[planId] = { ...share, reviews: [...share.reviews, review].slice(-MAX_REVIEWS) };
    this.save();
    this.push(plan, false);
    this.team.publish();
    const title = planTitle(plan);
    const what = r.kind === 'approve' ? `${name} approved “${title}”` : r.kind === 'suggest' ? `${name} suggests ${r.ops?.length === 1 ? 'a change' : `${r.ops?.length ?? 0} changes`} to “${title}”` : `${name} commented on “${title}”`;
    this.team.deps.notify?.({ kind: r.kind === 'suggest' ? 'needsYou' : 'people', tag: 'plan', title: what, body: r.text?.slice(0, 200) ?? (r.kind === 'suggest' ? 'Apply it in one click on the plan’s page.' : ''), plan: planId, key: `team-review:${r.id}` });
  }

  joined(link: TeamLink, fresh: boolean): void {
    if (!fresh) return;
    // A new teammate gets the plans already shared with the team.
    for (const share of Object.values(this.shares)) {
      const plan = this.plan(share.planId);
      if (!plan || plan.projectId !== link.projectId || share.peers.includes(link.peerId) || this.team.cannot(link.peerId, 'team.plans')) continue;
      this.shares[share.planId] = { ...share, peers: [...share.peers, link.peerId] };
      this.push(plan, true);
    }
    this.save();
  }

  left(link: TeamLink): void {
    for (const [id, share] of Object.entries(this.shares)) if (share.peers.includes(link.peerId)) this.shares[id] = { ...share, peers: share.peers.filter((p) => p !== link.peerId) };
    for (const [key, p] of Object.entries(this.received)) if (p.owner === link.peerId && p.projectId === link.projectId) delete this.received[key];
    this.save();
  }

  onAction(action: Action): void {
    if (action.type === 'plan_put' && this.shares[action.plan.id]) this.push(action.plan, false);
    if (action.type === 'plan_remove' && this.shares[action.id]) {
      const share = this.shares[action.id]!;
      for (const link of this.team.allLinks()) if (share.peers.includes(link.peerId)) this.team.send(link.peerId, { k: 'plan_gone', link: link.id, id: action.id }, `plan:${action.id}`);
      delete this.shares[action.id];
      this.save();
      this.team.publish();
    }
  }

  view(): Partial<TeamState> {
    return { plans: Object.values(this.received), planShares: { ...this.shares } };
  }

  // ------------------------------------------------------------------ the file

  private load(): void {
    if (!this.deps.dir) return;
    const saved = readJson(path.join(this.deps.dir, 'team-plans.json')) as { shares?: unknown; received?: unknown } | undefined;
    if (Array.isArray(saved?.shares)) this.shares = Object.fromEntries((saved.shares as MyPlanShare[]).filter((s) => s && typeof s.planId === 'string').map((s) => [s.planId, s]));
    if (Array.isArray(saved?.received)) this.received = Object.fromEntries((saved.received as SharedPlan[]).filter((p) => p && typeof p.owner === 'string' && typeof p.id === 'string').map((p) => [keyOf(p.owner, p.id), p]));
  }

  private save(): void {
    if (!this.deps.dir) return;
    try {
      writeJson(path.join(this.deps.dir, 'team-plans.json'), { shares: Object.values(this.shares), received: Object.values(this.received) });
    } catch {
      // Best effort.
    }
  }
}

/** A plan body as it travels: the same, without anything undefined. */
function wire(body: PlanBody): PlanBody {
  return JSON.parse(JSON.stringify(body)) as PlanBody;
}
