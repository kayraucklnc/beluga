import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TeamBoardSync } from '../../src/core/team/board-sync.js';
import { generateIdentity } from '../../src/net/crypto.js';
import { MAIL_LABEL, MAIL_TTL_MS, MAX_FROM_ONE, memoryMailboxes, sha256Hex } from '../../src/net/mailbox/handler.js';
import { readJson } from '../../src/net/mesh/files.js';
import { signText } from '../../src/net/mesh/keys.js';
import { type Crowd, befriend, crowd, settle } from '../mesh/helpers.js';
import { type PartsFor, type TeamMac, personOf, teamMac } from './helpers.js';

/** BLG-272: when two teammates are never online at the same time, the mailbox carries what waited. */

let net: Crowd | undefined;
const macs: TeamMac[] = [];

afterEach(async () => {
  for (const m of macs.splice(0)) await m.close();
  await net?.close();
  net = undefined;
});

const withSync: PartsFor = ({ team, board, dir }) => [new TeamBoardSync(team, { board, live: () => false, dir })];

async function teamUp(a: TeamMac, pa: string, b: TeamMac, pb: string): Promise<void> {
  await settle(() => a.store.getState().team.offers.find((o) => o.peerId === b.id && o.projectId === pa) && b.store.getState().team.offers.find((o) => o.peerId === a.id && o.projectId === pb));
  a.team.answer(b.id, pa, true);
  await settle(() => b.store.getState().team.offers.find((o) => o.peerId === a.id && o.state === 'invited'));
  b.team.answer(a.id, pb, true);
  await settle(() => a.store.getState().team.teams[pa]?.mates.some((m) => m.peerId === b.id) && b.store.getState().team.teams[pb]?.mates.some((m) => m.peerId === a.id));
}

const post = (url: string, body: unknown) => ({ url, init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } });

describe('the mailbox itself', () => {
  it('keeps signed mail for its owner only, deletes it when told, and forgets it after 7 days', async () => {
    let now = 1_000_000;
    const mb = memoryMailboxes(() => now);
    const ata = generateIdentity();
    const kay = generateIdentity();
    const put = (from = ata, id = 'mail-0001', sealed = '{"sealed":1}', sig = signText(from, MAIL_LABEL, `put:${kay.peerId}:${id}:${''}`)) => post(`https://m/v1/mail/${kay.peerId}`, { id, from: from.peerId, key: from.publicKey, sealed, sig });
    const signedPut = async (id: string, from = ata) => {
      const sealed = `{"n":"${id}"}`;
      return put(from, id, sealed, signText(from, MAIL_LABEL, `put:${kay.peerId}:${id}:${await sha256Hex(sealed)}`));
    };
    const call = async (r: { url: string; init: RequestInit }) => mb.fetch(r.url, r.init);
    const take = (who = kay) => call(post(`https://m/v1/mail/${kay.peerId}/take`, { key: who.publicKey, at: now, sig: signText(who, MAIL_LABEL, `take:${kay.peerId}:${now}`) }));

    expect((await call(put())).status).toBe(403);
    expect((await call(await signedPut('mail-0001'))).status).toBe(200);
    // A key that isn't the sender's own.
    const forged = await signedPut('mail-0002', kay);
    expect((await call({ ...forged, init: { ...forged.init, body: JSON.stringify({ ...JSON.parse(forged.init.body as string), from: ata.peerId }) } })).status).toBe(403);
    // Nobody else takes kay's mail.
    expect((await take(ata)).status).toBe(403);
    const got = (await (await take()).json()) as { mail: Array<{ id: string; from: string }> };
    expect(got.mail.map((m) => [m.id, m.from])).toEqual([['mail-0001', ata.peerId]]);
    const done = (ids: string[]) => call(post(`https://m/v1/mail/${kay.peerId}/done`, { key: kay.publicKey, at: now, ids, sig: signText(kay, MAIL_LABEL, `done:${kay.peerId}:${now}:${ids.join(',')}`) }));
    expect((await done(['mail-0001'])).status).toBe(200);
    expect(((await (await take()).json()) as { mail: unknown[] }).mail).toEqual([]);

    // Old mail goes, and one sender can't fill the box.
    await call(await signedPut('mail-0003'));
    now += MAIL_TTL_MS + 1;
    expect(((await (await take()).json()) as { mail: unknown[] }).mail).toEqual([]);
    for (let i = 0; i < MAX_FROM_ONE; i++) await call(await signedPut(`fill-${String(i).padStart(4, '0')}`));
    expect((await call(await signedPut('fill-over'))).status).toBe(507);
  });
});

describe('teammates never online together', () => {
  it('a change reaches kay through the mailbox, and kay’s ack clears ata’s outbox the same way', async () => {
    net = await crowd();
    const mb = memoryMailboxes();
    const mailbox = { url: 'https://mailbox.test', afterMs: 0, checkMs: 60_000, fetch: mb.fetch };
    const ata = await teamMac(net, 'ata', [{ id: 'pa', name: 'api', repo: 'acme/api' }], withSync, { mailbox });
    const kay = await teamMac(net, 'kay', [{ id: 'pk', name: 'api', repo: 'acme/api' }], withSync, { mailbox });
    macs.push(ata, kay);
    const t = ata.board.create({ projectId: 'pa', title: 'Shared' }, personOf(ata));
    await befriend(ata.person, kay.person);
    await teamUp(ata, 'pa', kay, 'pk');
    await settle(() => kay.board.get(t.id));

    // Kay goes offline; ata changes the task, it waits, goes to kay's mailbox, and ata goes offline too.
    await kay.stop();
    await settle(() => ata.person.friend(kay.id)?.online === false);
    ata.board.update(t.id, { title: 'Changed while kay was away', priority: 'high' }, personOf(ata));
    const waits = () => ata.team.courier.pending(kay.id, (m) => m.k === 'ops');
    expect(waits()).toBe(true);
    // BLG-273: the task says kay doesn't have it yet, then that it's in kay's mailbox.
    const waitingOn = () => ata.store.getState().team.waiting[t.id];
    await settle(() => waitingOn()?.some((w) => w.peerId === kay.id && !w.mailed));
    ata.team.courier.flush();
    await settle(() => waitingOn()?.some((w) => w.peerId === kay.id && w.mailed));
    await settle(() => mb.boxes.get(kay.id) && [...(mb.boxes.get(kay.id) as unknown as { items: Map<string, unknown> }).items.values()].length > 0);
    await ata.stop();

    // Kay comes back while ata is still away: the change is there all the same.
    await kay.start();
    await settle(() => kay.board.get(t.id)?.title === 'Changed while kay was away');
    expect(kay.board.get(t.id)?.priority).toBe('high');

    // Kay leaves before ata is back; ata finds kay's ack in its own mailbox: nothing waits any more.
    await settle(() => mb.boxes.get(ata.id) && (mb.boxes.get(ata.id) as unknown as { items: Map<string, unknown> }).items.size > 0);
    await kay.stop();
    const outbox = () => (readJson(path.join(ata.person.dir, 'team-outbox.json')) as Array<{ to: string; mailedAt?: number }>).filter((w) => w.to === kay.id);
    expect(outbox().some((w) => w.mailedAt)).toBe(true);
    await ata.start();
    await settle(() => !ata.team.courier.pending(kay.id, (m) => m.k === 'ops'));
    expect(ata.person.friend(kay.id)?.online).toBe(false);
    // Everyone has it: nothing on the task any more.
    await settle(() => !ata.store.getState().team.waiting[t.id]);
  }, 90_000);

  it('quitting mails what waits at once, without waiting for the timer', async () => {
    net = await crowd();
    const mb = memoryMailboxes();
    const mailbox = { url: 'https://mailbox.test', afterMs: 3_600_000, checkMs: 60_000, fetch: mb.fetch };
    const ata = await teamMac(net, 'ata', [{ id: 'pa', name: 'api', repo: 'acme/api' }], withSync, { mailbox });
    const kay = await teamMac(net, 'kay', [{ id: 'pk', name: 'api', repo: 'acme/api' }], withSync, { mailbox });
    macs.push(ata, kay);
    const t = ata.board.create({ projectId: 'pa', title: 'Shared' }, personOf(ata));
    await befriend(ata.person, kay.person);
    await teamUp(ata, 'pa', kay, 'pk');
    await settle(() => kay.board.get(t.id));

    await kay.stop();
    await settle(() => ata.person.friend(kay.id)?.online === false);
    ata.board.update(t.id, { title: 'Said just before quitting' }, personOf(ata));
    ata.team.courier.flush();
    expect(mb.boxes.get(kay.id)).toBeUndefined();
    // Quitting Beluga (the daemon calls leaveNetwork before it stops anything).
    await ata.person.mesh.leaving();
    await ata.stop();

    await kay.start();
    await settle(() => kay.board.get(t.id)?.title === 'Said just before quitting');
    await settle(() => (mb.boxes.get(ata.id) as unknown as { items: Map<string, unknown> } | undefined)?.items.size);
    await kay.stop();
    await ata.start();
    await settle(() => !ata.team.courier.pending(kay.id, (m) => m.k === 'ops'));
  }, 90_000);
});

describe('who’s on a task while a teammate is away (BLG-278)', () => {
  it('is never a change they are missing, and only the newest waits for them', async () => {
    net = await crowd();
    const live = new Set<string>();
    const running = new Set<string>();
    const parts: PartsFor = ({ team, board, dir }) => [new TeamBoardSync(team, { board, live: (id) => live.has(id), running: (id) => running.has(id), dir })];
    const ata = await teamMac(net, 'ata', [{ id: 'pa', name: 'api', repo: 'acme/api' }], parts);
    const kay = await teamMac(net, 'kay', [{ id: 'pk', name: 'api', repo: 'acme/api' }], parts);
    macs.push(ata, kay);
    const t = ata.board.create({ projectId: 'pa', title: 'Shared' }, personOf(ata));
    await befriend(ata.person, kay.person);
    await teamUp(ata, 'pa', kay, 'pk');
    await settle(() => kay.board.get(t.id));
    await kay.stop();
    await settle(() => ata.person.friend(kay.id)?.online === false);
    // Ata starts on it and their Claude starts and stops, twice: who's on it, nothing of the task.
    live.add('ws-1');
    ata.board.linkWorktree(t.id, 'ws-1', { name: 'shared' }, personOf(ata));
    const event = (e: 'started' | 'done') => ata.store.dispatch({ type: 'agent_event', owner: ata.id, requestId: `r-${e}`, requester: ata.id, event: e, text: '', ts: 1, channel: 'ws:ws-1' });
    for (let i = 0; i < 2; i++) {
      running.add('ws-1');
      event('started');
      running.delete('ws-1');
      event('done');
    }
    const ops = () => ata.team.courier.waitingFor((m) => m.k === 'ops').filter((w) => w.to === kay.id);
    expect(ops().length).toBe(1);
    expect(ata.store.getState().team.waiting[t.id]).toBeUndefined();
    // A real change still says kay doesn't have it.
    ata.board.update(t.id, { title: 'Renamed' }, personOf(ata));
    await settle(() => ata.store.getState().team.waiting[t.id]?.some((w) => w.peerId === kay.id));
  }, 60_000);
});
