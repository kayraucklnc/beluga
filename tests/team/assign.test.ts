import { afterEach, describe, expect, it } from 'vitest';
import { needsYou, tasksView } from '../../src/companion/views.js';
import { filterIssues } from '../../src/core/board/model.js';
import type { TaskView } from '../../src/core/gateway/model.js';
import { TeamAssign } from '../../src/core/team/assign.js';
import type { Assignee } from '../../src/core/board/model.js';
import { ownClaudeOnly } from '../../src/ipc/board-handlers.js';
import { TeamBoardSync } from '../../src/core/team/board-sync.js';
import { TASK_FEATURES } from '../../src/net/mesh/features.js';
import { type Crowd, befriend, crowd, settle } from '../mesh/helpers.js';
import { type PartsFor, type TeamMac, personOf, teamMac } from './helpers.js';

/** BLG-223: assigning a team task to a teammate reaches them as a notification. Their Claude is asked in a chat, never given a task (BLG-262). */

let net: Crowd | undefined;
const macs: TeamMac[] = [];

afterEach(async () => {
  for (const m of macs.splice(0)) await m.close();
  await net?.close();
  net = undefined;
});

const parts: PartsFor = ({ team, board, dir }) => {
  const sync = new TeamBoardSync(team, { board, live: () => false, dir });
  return [sync, new TeamAssign(team, { board, sync, dir })];
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
    // Ata's own Mac doesn't notify ata.
    expect(ata.notices.some((n) => n.tag === 'task')).toBe(false);

    // Seen: out of the inbox, still kay's.
    kay.team.part(TeamAssign).ack(t.id);
    expect(kay.store.getState().team.assigned).toEqual([]);
    expect(kay.board.get(t.id)!.assignee).toEqual(personOf(kay));
    // Both boards say who has it.
    expect(tasksView(ata.store.getState()).projects[0]?.groups.flatMap((g) => g.tasks).find((x) => x.id === t.id)?.assignee).toBe('kay');
  }, 60_000);

  it('a teammate’s Claude can’t be given a task: you ask it in a chat with them', () => {
    const kay: Assignee = { kind: 'claude', owner: 'p-kay', ownerName: 'kay' };
    expect(() => ownClaudeOnly(kay, 'p-ata')).toThrow(/ask it in a chat with kay/);
    // Your own Claude, a person, no one, or a task already theirs (left as it is): fine.
    expect(() => ownClaudeOnly({ kind: 'claude', owner: 'p-ata', ownerName: 'ata' }, 'p-ata')).not.toThrow();
    expect(() => ownClaudeOnly({ kind: 'person', id: 'p-kay', name: 'kay' }, 'p-ata')).not.toThrow();
    expect(() => ownClaudeOnly(null, 'p-ata')).not.toThrow();
    expect(() => ownClaudeOnly(kay, 'p-ata', kay)).not.toThrow();
  });

  it('a task given to a teammate’s Claude before still takes its answer: proof and a note for both', async () => {
    const [ata, kay] = await pair();
    const t = ata.board.create({ projectId: 'pa', title: 'Add rate limits' }, personOf(ata));
    await settle(() => kay.board.get(t.id));
    // A request sent the old way, saved on ata's Mac (team-asks.json).
    (ata.team.part(TeamAssign) as unknown as { asked: unknown[] }).asked = [{ task: 't_1', issueId: t.id, peerId: kay.id, at: 1 }];
    const done = { id: 't_1', direction: 'sent', peerId: kay.id, peerName: 'kay', kind: 'ask', ask: '', needs: [], by: 'person', state: 'done', steps: [], createdAt: 1, updatedAt: 2, result: { status: 'done', summary: 'Added a limiter in middleware.ts; tests pass', files: [], log: [] } } as unknown as TaskView;
    ata.store.dispatch({ type: 'gw_task', task: done });
    const here = ata.board.get(t.id)!;
    expect(here.proof.at(-1)).toMatchObject({ kind: 'text', title: "What kay's Claude did", by: { kind: 'claude', owner: kay.id } });
    await settle(() => kay.board.get(t.id)?.activity.some((a) => a.body === 'Added a limiter in middleware.ts; tests pass'));
  }, 60_000);
});
