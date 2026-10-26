import { afterEach, describe, expect, it } from 'vitest';
import { TeamBoardSync } from '../../src/core/team/board-sync.js';
import { merge, newer } from '../../src/core/team/crdt.js';
import { type Crowd, befriend, crowd, settle } from '../mesh/helpers.js';
import { type PartsFor, type TeamMac, personOf, teamMac } from './helpers.js';

/** BLG-222: a team's board stays in step on every Mac: tasks, briefs, status, comments. */

let net: Crowd | undefined;
const macs: TeamMac[] = [];

afterEach(async () => {
  for (const m of macs.splice(0)) await m.close();
  await net?.close();
  net = undefined;
});

/** Worktrees that count as live on a Mac (the rest are gone). */
const liveWs = new Set<string>();
const withSync: PartsFor = ({ team, board, dir }) => [new TeamBoardSync(team, { board, live: (id) => liveWs.has(id), dir })];

async function teamUp(a: TeamMac, pa: string, b: TeamMac, pb: string): Promise<void> {
  await settle(() => a.store.getState().team.offers.find((o) => o.peerId === b.id && o.projectId === pa) && b.store.getState().team.offers.find((o) => o.peerId === a.id && o.projectId === pb));
  a.team.answer(b.id, pa, true);
  await settle(() => b.store.getState().team.offers.find((o) => o.peerId === a.id && o.state === 'invited'));
  b.team.answer(a.id, pb, true);
  await settle(() => a.store.getState().team.teams[pa]?.mates.some((m) => m.peerId === b.id) && b.store.getState().team.teams[pb]?.mates.some((m) => m.peerId === a.id));
}

const issue = (m: TeamMac, id: string) => m.board.get(id);

describe('the CRDT', () => {
  it('settles conflicts the same whatever order they arrive in', () => {
    const x = { v: 'from ata', l: 5, a: 'a'.repeat(32) };
    const y = { v: 'from kay', l: 5, a: 'k'.repeat(32) };
    const z = { v: 'later', l: 6, a: 'a'.repeat(32) };
    expect(newer(y, x)).toBe(true);
    expect(newer(z, y)).toBe(true);
    const one = merge(merge(merge(undefined, { id: 't', fields: { title: x }, acts: [] }).task, { id: 't', fields: { title: y }, acts: [] }).task, { id: 't', fields: { title: z }, acts: [] }).task;
    const two = merge(merge(merge(undefined, { id: 't', fields: { title: z }, acts: [] }).task, { id: 't', fields: { title: x }, acts: [] }).task, { id: 't', fields: { title: y }, acts: [] }).task;
    expect(one.fields.title).toEqual(z);
    expect(two.fields.title).toEqual(z);
  });
});

describe('a team board over the network', () => {
  it('shares what each had, then every kind of change both ways, with keys of their own and nothing local', async () => {
    net = await crowd();
    const ata = await teamMac(net, 'ata', [{ id: 'pa', name: 'api', repo: 'acme/api' }], withSync);
    const kay = await teamMac(net, 'kay', [{ id: 'pk', name: 'acme-api', repo: 'acme/api' }], withSync);
    macs.push(ata, kay);
    const a1 = ata.board.create({ projectId: 'pa', title: 'Rate limits', brief: { goal: 'Stop abuse' } }, personOf(ata));
    const a2 = ata.board.create({ projectId: 'pa', title: 'Docs' }, personOf(ata));
    const k1 = kay.board.create({ projectId: 'pk', title: 'Login bug', priority: 'urgent' }, personOf(kay));
    await befriend(ata.person, kay.person);
    await teamUp(ata, 'pa', kay, 'pk');

    // Everything either had is on both boards: same ids, each Mac's own keys.
    await settle(() => issue(kay, a1.id) && issue(kay, a2.id) && issue(ata, k1.id));
    expect(issue(kay, a1.id)).toMatchObject({ title: 'Rate limits', projectId: 'pk', brief: { goal: 'Stop abuse' } });
    expect(issue(ata, k1.id)).toMatchObject({ title: 'Login bug', priority: 'urgent', projectId: 'pa' });
    const keys = (m: TeamMac) => m.board.list().map((i) => i.key);
    expect(new Set(keys(ata)).size).toBe(3);
    expect(new Set(keys(kay)).size).toBe(3);
    expect(issue(kay, a1.id)!.key.startsWith('ACM')).toBe(true);

    // Kay's edits reach ata, ata's reach kay.
    kay.board.update(a1.id, { title: 'Rate limits per key', status: 'in_progress', priority: 'high', labels: ['api'] }, personOf(kay));
    kay.board.editBrief(a1.id, 'acceptance', '- [ ] 429 after 100 calls', personOf(kay));
    kay.board.comment(a1.id, 'I can take this', personOf(kay));
    ata.board.update(k1.id, { status: 'in_review', estimate: 3, due: '2026-11-03' }, personOf(ata));
    const kid = ata.board.create({ projectId: 'pa', title: 'Sub-task', parent: k1.id }, personOf(ata));
    await settle(() => issue(ata, a1.id)?.activity.some((a) => a.body === 'I can take this') && issue(kay, kid.id));
    expect(issue(ata, a1.id)).toMatchObject({ title: 'Rate limits per key', status: 'in_progress', priority: 'high', labels: ['api'], brief: { goal: 'Stop abuse', acceptance: '- [ ] 429 after 100 calls' } });
    // The brief came with its history (Restore This works on it).
    expect(issue(ata, a1.id)!.revisions.at(-1)).toMatchObject({ section: 'acceptance', by: { kind: 'person', id: kay.id } });
    expect(issue(ata, a1.id)!.activity.find((a) => a.body === 'I can take this')?.by).toEqual(personOf(kay));
    await settle(() => issue(kay, k1.id)?.status === 'in_review');
    expect(issue(kay, k1.id)).toMatchObject({ estimate: 3, due: '2026-11-03' });
    expect(issue(kay, kid.id)?.parent).toBe(k1.id);

    // Worktrees stay local: ata starting one shows kay only "ata is working on this".
    liveWs.add('ws-ata-1');
    ata.board.linkWorktree(a2.id, 'ws-ata-1', { name: 'docs-pass', branch: 'beluga/docs' }, personOf(ata));
    await settle(() => kay.store.getState().team.working[a2.id]?.some((w) => w.peerId === ata.id));
    expect(issue(kay, a2.id)!.worktrees).toEqual([]);
    expect(issue(kay, a2.id)!.branch).toBeUndefined();
    expect(issue(kay, a2.id)!.activity.some((a) => a.kind === 'worktree' || a.text.includes('docs-pass'))).toBe(false);

    // Deleting goes for everyone.
    ata.board.remove(a2.id);
    await settle(() => !issue(kay, a2.id));
  }, 90_000);

  it('changes made offline arrive when back, and a conflict settles the same on both Macs', async () => {
    net = await crowd();
    const ata = await teamMac(net, 'ata', [{ id: 'pa', name: 'api', repo: 'acme/api' }], withSync);
    const kay = await teamMac(net, 'kay', [{ id: 'pk', name: 'api', repo: 'acme/api' }], withSync);
    macs.push(ata, kay);
    const t = ata.board.create({ projectId: 'pa', title: 'Shared' }, personOf(ata));
    await befriend(ata.person, kay.person);
    await teamUp(ata, 'pa', kay, 'pk');
    await settle(() => issue(kay, t.id));

    // Kay's network is off: both change the same field, and different ones.
    await kay.stop();
    await settle(() => ata.person.friend(kay.id)?.online === false);
    ata.board.update(t.id, { title: 'Title from ata', priority: 'high' }, personOf(ata));
    ata.board.comment(t.id, 'ata offline note', personOf(ata));
    kay.board.update(t.id, { title: 'Title from kay', labels: ['web'] }, personOf(kay));
    kay.board.comment(t.id, 'kay offline note', personOf(kay));
    const made = kay.board.create({ projectId: 'pk', title: 'Made offline' }, personOf(kay));
    await kay.start();

    await settle(() => issue(ata, made.id) && issue(ata, t.id)?.labels.includes('web') && issue(kay, t.id)?.priority === 'high');
    await settle(() => issue(ata, t.id)?.title === issue(kay, t.id)?.title);
    expect(['Title from ata', 'Title from kay']).toContain(issue(ata, t.id)!.title);
    for (const m of [ata, kay]) {
      const bodies = issue(m, t.id)!.activity.map((a) => a.body).filter(Boolean);
      expect(bodies).toEqual(expect.arrayContaining(['ata offline note', 'kay offline note']));
    }
  }, 90_000);

  it('three teammates agree even where two of them aren’t friends', async () => {
    net = await crowd();
    const ata = await teamMac(net, 'ata', [{ id: 'pa', name: 'api', repo: 'acme/api' }], withSync);
    const kay = await teamMac(net, 'kay', [{ id: 'pk', name: 'api', repo: 'acme/api' }], withSync);
    const mia = await teamMac(net, 'mia', [{ id: 'pm', name: 'api', repo: 'acme/api' }], withSync);
    macs.push(ata, kay, mia);
    await befriend(ata.person, kay.person);
    await befriend(kay.person, mia.person);
    await teamUp(ata, 'pa', kay, 'pk');
    await teamUp(kay, 'pk', mia, 'pm');
    const t = ata.board.create({ projectId: 'pa', title: 'From ata' }, personOf(ata));
    await settle(() => issue(mia, t.id));
    mia.board.update(t.id, { status: 'done' }, personOf(mia));
    await settle(() => issue(ata, t.id)?.status === 'done');
  }, 90_000);
});
