import { afterEach, describe, expect, it } from 'vitest';
import { needsYou } from '../../src/companion/views.js';
import type { WsRole } from '../../src/protocol.js';
import { TeamBoardSync } from '../../src/core/team/board-sync.js';
import { TeamKnocks } from '../../src/core/team/knock.js';
import { myKnockOn, myKnockWords } from '../../src/core/team/model.js';
import { type Crowd, befriend, crowd, settle } from '../mesh/helpers.js';
import { type PartsFor, type TeamMac, personOf, teamMac } from './helpers.js';

/** BLG-416: knocking on a teammate's worktree; they let you in as a viewer or an editor, or say not now. */

let net: Crowd | undefined;
const macs: TeamMac[] = [];
const liveWs = new Set<string>();
const letIns: Array<{ host: string; peerId: string; workspaceId: string; role: WsRole }> = [];

afterEach(async () => {
  for (const m of macs.splice(0)) await m.close();
  await net?.close();
  net = undefined;
  liveWs.clear();
  letIns.length = 0;
});

const parts: PartsFor = ({ team, board, store, name, dir }) => [
  new TeamBoardSync(team, { board, live: (id) => liveWs.has(id), dir }),
  new TeamKnocks(team, {
    board,
    store,
    live: (id) => liveWs.has(id),
    // What friend-share does when it shares one worktree: they're a member of it.
    letIn: (peerId, workspaceId, role) => {
      letIns.push({ host: name, peerId, workspaceId, role });
      store.dispatch({ type: 'member_set', id: workspaceId, peerId, role });
    },
    dir,
  }),
];

/** Ata and kay on one team; ata's worktree `ws-ata` does a task, and kay's board says so. */
async function setup(): Promise<{ ata: TeamMac; kay: TeamMac; taskId: string }> {
  net = await crowd();
  const ata = await teamMac(net, 'ata', [{ id: 'pa', name: 'api', repo: 'acme/api' }], parts);
  const kay = await teamMac(net, 'kay', [{ id: 'pk', name: 'kays-api', repo: 'acme/api' }], parts);
  macs.push(ata, kay);
  await befriend(ata.person, kay.person);
  await settle(() => ata.store.getState().team.offers[0] && kay.store.getState().team.offers[0]);
  ata.team.answer(kay.id, 'pa', true);
  await settle(() => kay.store.getState().team.offers[0]?.state === 'invited');
  kay.team.answer(ata.id, 'pk', true);
  await settle(() => ata.store.getState().team.teams.pa && kay.store.getState().team.teams.pk);
  const t = ata.board.create({ projectId: 'pa', title: 'Add rate limits' }, personOf(ata));
  liveWs.add('ws-ata');
  ata.board.linkWorktree(t.id, 'ws-ata', { name: 'add-rate-limits' }, personOf(ata));
  await settle(() => kay.store.getState().team.working[t.id]?.some((p) => p.peerId === ata.id));
  return { ata, kay, taskId: t.id };
}

describe('knocking on a teammate’s worktree', () => {
  it('knock, a card in the worktree’s chat and the bell, let in as an editor', async () => {
    const { ata, kay, taskId } = await setup();
    const mine = kay.team.part(TeamKnocks).knock(taskId, undefined, 'I can take the tests');
    expect(mine.state).toBe('waiting');
    expect(myKnockWords(myKnockOn(kay.store.getState().team, taskId)!)).toBe('Knocked. Waiting for ata to let you in');
    // Knocking twice is the same knock.
    expect(kay.team.part(TeamKnocks).knock(taskId).id).toBe(mine.id);

    const k = await settle(() => ata.store.getState().team.knocks?.[0]);
    expect(k).toMatchObject({ peerId: kay.id, name: 'kay', workspaceId: 'ws-ata', issueId: taskId, note: 'I can take the tests' });
    const line = ata.store.getState().log.find((l) => l.id === `wt-knock-${k.id}`);
    expect(line).toMatchObject({ type: 'system', channel: 'ws:ws-ata' });
    expect(ata.notices.find((n) => n.need === `wt-knock:${k.id}`)).toMatchObject({ kind: 'needsYou', channel: 'ws:ws-ata' });
    const card = needsYou(ata.store.getState()).find((n) => n.id === `wt-knock:${k.id}`);
    expect(card?.actions.map((a) => [a.label, a.args[1]])).toEqual([
      ['Let In as Editor', 'contribute'],
      ['Not Now', 'decline'],
      ['Let In as Viewer', 'view'],
    ]);

    ata.team.part(TeamKnocks).answer(k.id, 'contribute');
    expect(letIns).toEqual([{ host: 'ata', peerId: kay.id, workspaceId: 'ws-ata', role: 'contribute' }]);
    expect(ata.store.getState().team.knocks).toEqual([]);
    expect(ata.store.getState().log.some((l) => l.channel === 'ws:ws-ata' && l.type === 'system' && l.text === 'You let kay in as an editor')).toBe(true);

    const answered = await settle(() => (myKnockOn(kay.store.getState().team, taskId)?.state === 'in' ? myKnockOn(kay.store.getState().team, taskId) : undefined));
    expect(answered).toMatchObject({ role: 'contribute', workspaceId: 'ws-ata' });
    expect(kay.notices.some((n) => n.title === 'ata let you in as an editor')).toBe(true);

    // Knocking again once in: straight back in, nothing asked.
    kay.team.part(TeamKnocks).cancel(answered!.id);
    kay.team.part(TeamKnocks).knock(taskId);
    await settle(() => myKnockOn(kay.store.getState().team, taskId)?.state === 'in');
    expect(ata.store.getState().team.knocks).toEqual([]);
  }, 60_000);

  it('not now, taking a knock back, and a worktree that went', async () => {
    const { ata, kay, taskId } = await setup();
    const knocks = kay.team.part(TeamKnocks);

    knocks.knock(taskId);
    const k = await settle(() => ata.store.getState().team.knocks?.[0]);
    ata.team.part(TeamKnocks).answer(k.id, 'decline');
    await settle(() => myKnockOn(kay.store.getState().team, taskId)?.state === 'declined');
    expect(letIns).toEqual([]);

    // Taken back: gone from ata's Mac too.
    const again = knocks.knock(taskId);
    await settle(() => ata.store.getState().team.knocks?.length === 1);
    knocks.cancel(again.id);
    await settle(() => ata.store.getState().team.knocks?.length === 0);
    expect(ata.store.getState().log.some((l) => l.type === 'system' && l.text === 'kay took their knock back')).toBe(true);

    // The worktree went while a knock waited: answered by itself.
    knocks.knock(taskId);
    await settle(() => ata.store.getState().team.knocks?.length === 1);
    liveWs.delete('ws-ata');
    ata.store.dispatch({ type: 'projects', projects: ata.store.getState().projects });
    await settle(() => myKnockOn(kay.store.getState().team, taskId)?.state === 'gone');
    expect(ata.store.getState().team.knocks).toEqual([]);
  }, 60_000);

  it('only a task a teammate is on can be knocked on', async () => {
    const { kay } = await setup();
    const own = kay.board.create({ projectId: 'pk', title: 'Mine alone' }, personOf(kay));
    expect(() => kay.team.part(TeamKnocks).knock(own.id)).toThrow('No teammate is working on that task right now');
  }, 60_000);
});
