import { afterEach, describe, expect, it } from 'vitest';
import { needsYou, tasksView } from '../../src/companion/views.js';
import { filterIssues } from '../../src/core/board/model.js';
import type { TaskView } from '../../src/core/gateway/model.js';
import { TeamAssign } from '../../src/core/team/assign.js';
import { TeamBoardSync } from '../../src/core/team/board-sync.js';
import { TASK_FEATURES } from '../../src/net/mesh/features.js';
import { type Crowd, befriend, crowd, settle } from '../mesh/helpers.js';
import { type PartsFor, type TeamMac, personOf, teamMac } from './helpers.js';

/** BLG-223: assigning a team task to a teammate or their Claude reaches them as a notification. */

let net: Crowd | undefined;
const macs: TeamMac[] = [];

afterEach(async () => {
  for (const m of macs.splice(0)) await m.close();
  await net?.close();
  net = undefined;
});

/** What each Mac's gateway was asked (a stand-in: the gateway's own tests cover the request itself). */
const asks: Array<{ from: string; peerId: string; ask: string; summary: string; project: string | undefined }> = [];
const parts: PartsFor = ({ team, board, dir, name }) => {
  const sync = new TeamBoardSync(team, { board, live: () => false, dir });
  const askClaude = (peerId: string, ask: string, summary: string, project: string | undefined): string => {
    asks.push({ from: name, peerId, ask, summary, project });
    return `t_${asks.length}`;
  };
  return [sync, new TeamAssign(team, { board, sync, askClaude, dir })];
};

async function pair(): Promise<[TeamMac, TeamMac]> {
  net = await crowd();
  const ata = await teamMac(net, 'ata', [{ id: 'pa', name: 'api', repo: 'acme/api' }], parts);
  const kay = await teamMac(net, 'kay', [{ id: 'pk', name: 'kays-api', repo: 'acme/api' }], parts);
  macs.push(ata, kay);
  // Their gateways listen (a Mac without one is told the cannotTake way, see below).
  for (const m of [ata, kay]) m.person.mesh.offer(TASK_FEATURES, true);
  await befriend(ata.person, kay.person);
  await settle(() => ata.store.getState().team.offers[0] && kay.store.getState().team.offers[0]);
  ata.team.answer(kay.id, 'pa', true);
  await settle(() => kay.store.getState().team.offers[0]?.state === 'invited');
  kay.team.answer(ata.id, 'pk', true);
  await settle(() => ata.store.getState().team.teams.pa && kay.store.getState().team.teams.pk);
  return [ata, kay];
}

describe('assigning team tasks', () => {
  it('to a teammate: their My Tasks, a notification and a phone card until they’ve seen it', async () => {
    const [ata, kay] = await pair();
    const t = ata.board.create({ projectId: 'pa', title: 'Fix the login' }, personOf(ata));
    await settle(() => kay.board.get(t.id));
    ata.board.update(t.id, { assignee: personOf(kay) }, personOf(ata));

    const inbox = await settle(() => kay.store.getState().team.assigned.find((a) => a.issueId === t.id));
    expect(inbox).toMatchObject({ by: 'ata', byId: ata.id, title: 'Fix the login' });
    expect(filterIssues(kay.store.getState().board, { scope: 'mine', selfId: kay.id }).map((i) => i.id)).toEqual([t.id]);
    expect(kay.notices.find((n) => n.tag === 'task')?.title).toBe(`ata gave you ${kay.board.get(t.id)!.key}`);
    const card = needsYou(kay.store.getState()).find((n) => n.id === `team-task:${t.id}`);
    expect(card?.actions[0]).toMatchObject({ label: 'Got It', method: 'team.ackAssignment' });
    // Ata's own Mac doesn't notify ata, and isn't asked anything.
    expect(ata.notices.some((n) => n.tag === 'task')).toBe(false);
    expect(asks).toHaveLength(0);

    // Seen: out of the inbox, still kay's.
    kay.team.part(TeamAssign).ack(t.id);
    expect(kay.store.getState().team.assigned).toEqual([]);
    expect(kay.board.get(t.id)!.assignee).toEqual(personOf(kay));
    // Both boards say who has it.
    expect(tasksView(ata.store.getState()).projects[0]?.groups.flatMap((g) => g.tasks).find((x) => x.id === t.id)?.assignee).toBe('kay');
  }, 60_000);

  it('to a teammate’s Claude: a request with the brief from the Mac that assigned it; the result lands on the task for both', async () => {
    asks.length = 0;
    const [ata, kay] = await pair();
    const t = ata.board.create({ projectId: 'pa', title: 'Add rate limits', brief: { goal: 'Stop abuse', acceptance: '- [ ] 429 after 100 calls' } }, personOf(ata));
    await settle(() => kay.board.get(t.id));
    ata.board.update(t.id, { assignee: { kind: 'claude', owner: kay.id, ownerName: 'kay' } }, personOf(ata));

    await settle(() => asks.length === 1);
    expect(asks[0]).toMatchObject({ from: 'ata', peerId: kay.id, project: 'kays-api' });
    expect(asks[0]!.ask).toContain('Stop abuse');
    expect(asks[0]!.ask).toContain('429 after 100 calls');
    // Kay hears their Claude was given it (the request itself asks kay, as usual).
    await settle(() => kay.notices.find((n) => n.tag === 'task' && n.title.includes('your Claude')));
    // Kay's Mac never sends one of its own.
    expect(asks.every((a) => a.from === 'ata')).toBe(true);

    // The answer comes back on ata's gateway: proof and a note on the task, and the note reaches kay.
    const done = { id: 't_1', direction: 'sent', peerId: kay.id, peerName: 'kay', kind: 'ask', ask: '', needs: [], by: 'person', state: 'done', steps: [], createdAt: 1, updatedAt: 2, result: { status: 'done', summary: 'Added a limiter in middleware.ts; tests pass', files: [], log: [] } } as unknown as TaskView;
    ata.store.dispatch({ type: 'gw_task', task: done });
    const here = ata.board.get(t.id)!;
    expect(here.proof.at(-1)).toMatchObject({ kind: 'text', title: "What kay's Claude did", by: { kind: 'claude', owner: kay.id } });
    expect(here.activity.at(-1)).toMatchObject({ kind: 'note', body: 'Added a limiter in middleware.ts; tests pass' });
    await settle(() => kay.board.get(t.id)?.activity.some((a) => a.body === 'Added a limiter in middleware.ts; tests pass'));

    // A teammate whose Beluga doesn't take requests right now: a note on the task says so, nothing is sent.
    kay.person.mesh.offer(TASK_FEATURES, false);
    await settle(() => !ata.person.mesh.belugaOf(kay.id)?.can.includes('task.ask'));
    ata.board.update(t.id, { assignee: null }, personOf(ata));
    ata.board.update(t.id, { assignee: { kind: 'claude', owner: kay.id, ownerName: 'kay' } }, personOf(ata));
    expect(asks).toHaveLength(1);
    expect(ata.board.get(t.id)!.activity.at(-1)?.body).toMatch(/kay's Beluga isn't taking requests right now/);
  }, 60_000);
});
