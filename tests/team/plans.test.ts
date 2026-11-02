import { afterEach, describe, expect, it } from 'vitest';
import { needsYou } from '../../src/companion/views.js';
import { Plans } from '../../src/core/plans/plans.js';
import { TeamBoardSync } from '../../src/core/team/board-sync.js';
import { TeamPlans } from '../../src/core/team/plan-share.js';
import { type Crowd, befriend, crowd, settle } from '../mesh/helpers.js';
import { type PartsFor, type TeamMac, personOf, teamMac } from './helpers.js';

/** BLG-225: share a plan draft with teammates to review, comment, suggest changes or approve. */

let net: Crowd | undefined;
const macs: TeamMac[] = [];
const plansOf = new Map<string, Plans>();

afterEach(async () => {
  for (const m of macs.splice(0)) await m.close();
  await net?.close();
  net = undefined;
});

const parts: PartsFor = ({ team, board, store, dir, name }) => {
  const plans = plansOf.get(name) ?? new Plans({ store, dir: null });
  plansOf.set(name, plans);
  return [new TeamBoardSync(team, { board, live: () => false, dir }), new TeamPlans(team, { edit: (id, ops) => void plans.editDraft(id, ops, { kind: 'person', id: team.self, name }), dir })];
};

describe('shared plan drafts', () => {
  it('nothing goes until shared; teammates see it, comment, suggest and approve; the owner applies in one click and changes reach them live', async () => {
    net = await crowd();
    plansOf.clear();
    const ata = await teamMac(net, 'ata', [{ id: 'pa', name: 'api', repo: 'acme/api' }], parts);
    const kay = await teamMac(net, 'kay', [{ id: 'pk', name: 'api', repo: 'acme/api' }], parts);
    macs.push(ata, kay);
    await befriend(ata.person, kay.person);
    await settle(() => ata.store.getState().team.offers[0] && kay.store.getState().team.offers[0]);
    ata.team.answer(kay.id, 'pa', true);
    await settle(() => kay.store.getState().team.offers[0]?.state === 'invited');
    kay.team.answer(ata.id, 'pk', true);
    await settle(() => ata.store.getState().team.teams.pa && kay.store.getState().team.teams.pk);

    const plans = plansOf.get('ata')!;
    const plan = plans.create({ projectId: 'pa', home: 'ws:home', title: 'Rate limits' }, personOf(ata));
    plans.writeDraft(plan.id, { title: 'Rate limits', goal: 'Stop abuse of the API', milestones: [{ id: 'm1', title: 'Limiter', criteria: ['429 after 100 calls'], tasks: [{ id: 'mw', title: 'Middleware', goal: 'Count calls per key' }] }] }, personOf(ata));

    // Not shared yet: nothing on kay's Mac.
    await new Promise((r) => setTimeout(r, 300));
    expect(kay.store.getState().team.plans).toEqual([]);

    ata.team.part(TeamPlans).share(plan.id, true);
    const seen = await settle(() => kay.store.getState().team.plans[0]);
    expect(seen).toMatchObject({ owner: ata.id, ownerName: 'ata', id: plan.id, projectId: 'pk', title: 'Rate limits', status: 'draft' });
    expect(seen.body.milestones[0]?.tasks.map((t) => t.title)).toEqual(['Middleware']);
    expect(kay.notices.some((n) => n.title === 'ata shared the plan “Rate limits” with you')).toBe(true);
    // The phone asks kay to approve it (or comment).
    const card = needsYou(kay.store.getState()).find((n) => n.id.startsWith(`team-plan:${ata.id}:${plan.id}`));
    expect(card?.actions[0]).toMatchObject({ label: 'Approve', method: 'team.reviewPlan' });
    expect(card?.answer?.method).toBe('team.reviewPlan');

    // Kay comments and suggests a change; ata is told, and sees both.
    const tp = kay.team.part(TeamPlans);
    tp.review(ata.id, plan.id, { kind: 'comment', text: 'Per key or per IP?' });
    const s = tp.review(ata.id, plan.id, { kind: 'suggest', text: 'Clearer', ops: [{ op: 'update_task', id: 'mw', patch: { title: 'Rate-limit middleware' } }] });
    await settle(() => ata.store.getState().team.planShares[plan.id]?.reviews.length === 2);
    expect(ata.notices.some((n) => n.title === 'kay commented on “Rate limits”')).toBe(true);
    expect(ata.notices.some((n) => n.title === 'kay suggests a change to “Rate limits”')).toBe(true);
    expect(needsYou(ata.store.getState()).find((n) => n.id === `team-suggest:${s.id}`)?.actions.map((a) => a.label)).toEqual(['Apply', 'Set Aside']);

    // One click: it's in ata's draft, and kay's copy follows live.
    ata.team.part(TeamPlans).apply(plan.id, s.id);
    expect(plans.need(plan.id).draft?.milestones[0]?.tasks[0]?.title).toBe('Rate-limit middleware');
    await settle(() => kay.store.getState().team.plans[0]?.body.milestones[0]?.tasks[0]?.title === 'Rate-limit middleware');
    expect(kay.store.getState().team.plans[0]?.reviews.find((r) => r.id === s.id)?.settled).toBe('applied');
    expect(() => ata.team.part(TeamPlans).apply(plan.id, s.id)).toThrow(/in already/);

    // Kay approves the revision they see.
    tp.review(ata.id, plan.id, { kind: 'approve' });
    await settle(() => ata.store.getState().team.planShares[plan.id]?.reviews.some((r) => r.kind === 'approve' && r.by === kay.id));
    expect(ata.notices.some((n) => n.title === 'kay approved “Rate limits”')).toBe(true);
    await settle(() => !needsYou(kay.store.getState()).some((n) => n.id.startsWith(`team-plan:${ata.id}`)));

    // Stop Sharing: gone from kay's Mac.
    ata.team.part(TeamPlans).share(plan.id, false);
    await settle(() => kay.store.getState().team.plans.length === 0);
  }, 60_000);
});
