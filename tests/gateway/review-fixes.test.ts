import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CAPABILITIES } from '../../src/core/gateway/access.js';
import { TaskBook } from '../../src/core/gateway/book.js';
import { pretendSystem } from '../../src/core/gateway/demo-system.js';
import { readResultFiles } from '../../src/core/gateway/result.js';
import { RuleBook, realFolder } from '../../src/core/gateway/rule-book.js';
import { Courier } from '../../src/core/gateway/transport.js';
import type { NoticeEvent } from '../../src/core/notify.js';
import { isSecretPath } from '../../src/core/shares.js';
import { type Crowd, befriend, crowd, settle } from '../mesh/helpers.js';
import { type Node, node, task } from './helpers.js';

/**
 * Fixes from the review of approvals, rules and capabilities: each test here fails without its fix.
 */

let net: Crowd;
beforeAll(async () => {
  net = await crowd();
}, 30_000);
afterAll(async () => {
  await net?.close();
});

async function pair(a: string, b: string, extraA: Parameters<typeof node>[2] = {}, extraB: Parameters<typeof node>[2] = {}): Promise<[Node, Node]> {
  const x = await node(net, a, extraA);
  const y = await node(net, b, extraB);
  await befriend(x.person, y.person);
  return [x, y];
}

const scratch = (name: string): string => realpathSync(mkdtempSync(path.join(os.tmpdir(), `klaud-fix-${name}-`)));

describe('klaud’s own folder (isSecretPath)', () => {
  const saved = { KLAUD_HOME: process.env.KLAUD_HOME, HOME: process.env.HOME };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('friends’ task folders in it stay usable (screenshots and files can go back); the rest stays secret', async () => {
    const home = path.join(scratch('home'), '.klaud');
    process.env.KLAUD_HOME = home;
    const work = path.join(home, 'tasks', 'work', 't_abcdefghijk', 'screens');
    mkdirSync(work, { recursive: true });
    writeFileSync(path.join(work, 'screen.png'), 'png');
    expect(isSecretPath(path.join(work, 'screen.png'))).toBe(false);
    expect(isSecretPath(path.join(home, 'tasks', 'files', 't_abcdefghijk', 'report.md'))).toBe(false);
    expect(isSecretPath(path.join(home, 'tasks', 'tasks.json'))).toBe(true);
    expect(isSecretPath(path.join(home, 'tasks', 'outbox.json'))).toBe(true);
    expect(isSecretPath(path.join(home, 'rules.json'))).toBe(true);
    expect(isSecretPath(path.join(home, 'identity.json'))).toBe(true);
    // A result can carry it (the scratch folder is under ~/.klaud in real use).
    const { files, skipped } = await readResultFiles([path.join(work, 'screen.png')], { roots: [path.join(home, 'tasks', 'work', 't_abcdefghijk')], anywhere: false });
    expect(skipped).toEqual([]);
    expect(files[0]).toMatchObject({ name: 'screen.png', image: true });
  });

  it('is found however it’s written: other case on a Mac, through a link, or the old ~/.klaude', () => {
    const base = scratch('home2');
    const home = path.join(base, '.klaud');
    mkdirSync(home, { recursive: true });
    process.env.KLAUD_HOME = home;
    process.env.HOME = base;
    if (process.platform === 'darwin') expect(isSecretPath(path.join(base, '.KLAUD', 'identity.json'))).toBe(true);
    const link = path.join(scratch('link'), 'k');
    symlinkSync(home, link);
    expect(isSecretPath(path.join(link, 'identity.json'))).toBe(true);
    expect(isSecretPath(path.join(base, '.klaude', 'identity.json'))).toBe(true);
    expect(isSecretPath(path.join(base, '.klaude', 'workspaces', 'api', 'README.md'))).toBe(false);
  });
});

describe('capabilities hold on every tool call', () => {
  it('Off holds even with full trust; a Decline rule too; Allow lets commands run without asking', async () => {
    let caps: unknown;
    const [kay, bob] = await pair('fixA1', 'fixA2', {}, { loadCaps: () => caps, saveCaps: (c) => void (caps = c) });
    kay.trust(bob.id, 'trusted');
    bob.trust(kay.id, 'full');
    bob.gw.setCapabilities({ levels: { shell: { ...DEFAULT_CAPABILITIES.levels.shell, full: 'off' } } });
    const seen: Array<[string, string | undefined, boolean]> = [];
    bob.claude.answer = async (input) => {
      for (const tool of ['Bash', 'Write', 'Read']) seen.push([tool, input.vetTool?.(tool, {}), await input.canUseTool(tool, {})]);
      return 'ok';
    };
    const t = kay.gw.ask({ person: 'fixA2', ask: 'look around', by: 'agent' });
    await settle(() => task(kay, t.id)?.state === 'done');
    expect(seen[0]![0]).toBe('Bash');
    expect(seen[0]![1]).toContain("doesn't let friends' Claudes run commands");
    expect(seen[0]![2]).toBe(false);
    expect(seen.slice(1).map(([tool, veto, ok]) => [tool, veto, ok])).toEqual([
      ['Write', undefined, true],
      ['Read', undefined, true],
    ]);
    // A Decline rule for writing files, with full trust.
    bob.gw.saveRule({ peerId: kay.id, peerName: 'fixA1', kind: 'task', needs: ['files'], decision: 'decline' });
    seen.length = 0;
    const t2 = kay.gw.ask({ person: 'fixA2', ask: 'tidy up', by: 'agent' });
    await settle(() => task(kay, t2.id)?.state === 'done');
    expect(seen.find(([tool]) => tool === 'Write')).toEqual(['Write', expect.stringContaining('a rule for this person'), false]);
    expect(bob.approvals).toHaveLength(0);
  }, 60_000);
});

describe('questions: once each, a few per task, and your answer seen first', () => {
  it('a replayed or answered question isn’t asked again; past the limit they’re told to go on', async () => {
    const [kay, bob] = await pair('fixB1', 'fixB2');
    kay.trust(bob.id, 'trusted');
    bob.trust(kay.id, 'trusted');
    bob.claude.hold();
    const t = kay.gw.ask({ person: 'fixB2', ask: 'a long job', by: 'person' });
    await settle(() => task(kay, t.id)?.state === 'working');
    const ask = (f: string, qid: string): void =>
      kay.gw.onRoomFrame(bob.id, { f, m: { t: 'task_question', id: t.id, qid, questions: [{ question: `Q ${qid}?`, header: '', options: [], multiSelect: false }], ts: 1 } });
    ask('frame-0000001', 'q_first01');
    expect(task(kay, t.id)?.question?.qid).toBe('q_first01');
    kay.gw.answer(t.id, ['yes'], 'person');
    // The same question again (a new frame): already answered.
    ask('frame-0000002', 'q_first01');
    expect(task(kay, t.id)?.question).toBeUndefined();
    for (let i = 2; i <= 5; i++) {
      ask(`frame-000000${i + 1}`, `q_next0${i}`);
      kay.gw.answer(t.id, 'skip', 'person');
    }
    ask('frame-0000099', 'q_toomany');
    expect(task(kay, t.id)?.question).toBeUndefined();
    expect(task(kay, t.id)?.asked).toHaveLength(5);
    bob.claude.open();
  }, 60_000);

  it('a frame that comes twice is handed on once (but acknowledged both times)', () => {
    const sent: unknown[] = [];
    const courier = new Courier(new TaskBook(null), { mesh: () => undefined, room: () => ({ present: () => true, send: (_to, frame) => (sent.push(frame), true) }) });
    const frame = { f: 'frame-dup-001', m: { t: 'task_cancel', id: 't_abcdefghijk', ts: 1 } };
    expect(courier.receive('peer-0000001', 'room', frame)).toMatchObject({ t: 'task_cancel' });
    expect(courier.receive('peer-0000001', 'room', frame)).toBeUndefined();
    expect(sent).toEqual([{ ack: 'frame-dup-001' }, { ack: 'frame-dup-001' }]);
  });

  it('your Claude’s answer goes straight out only for a task you saw (Ask on the card)', async () => {
    const [kay, bob] = await pair('fixC1', 'fixC2');
    bob.trust(kay.id, 'trusted');
    let answer = '';
    bob.claude.answer = async (input) => {
      const a = await input.askUser!({ kind: 'question', questions: [{ question: 'Which branch?', header: '', options: [], multiSelect: false }] });
      answer = a.kind === 'answers' ? Object.values(a.answers)[0]! : 'skip';
      return 'done';
    };
    // kay doesn't trust bob: the card asks first, and kay says Ask.
    const t = kay.gw.ask({ person: 'fixC2', ask: 'check the build', by: 'agent', conversation: 'ws:x' });
    kay.gw.confirm(t.id, true);
    await settle(() => task(kay, t.id)?.question);
    const sent = kay.gw.answer(t.id, ['main'], 'agent');
    expect(sent.answerDraft).toBeUndefined();
    await settle(() => task(kay, t.id)?.state === 'done');
    expect(answer).toBe('main');
  }, 60_000);
});

describe('nothing left hanging when the disk says no', () => {
  it('a result that can’t be saved ends the task (failed), saying why', async () => {
    const [kay, bob] = await pair('fixD1', 'fixD2');
    kay.trust(bob.id, 'trusted');
    bob.trust(kay.id, 'trusted');
    const shared = scratch('d-shared');
    writeFileSync(path.join(shared, 'notes.md'), '# n');
    bob.claude.answer = async (input) => {
      writeFileSync(path.join(input.place!.cwd, 'out.md'), 'hello');
      return `Here.\n\n\`\`\`klaud-result\n{"files": ["${path.join(input.place!.cwd, 'out.md')}"]}\n\`\`\``;
    };
    // Where kay's files go is blocked by a file of the same name.
    const dir = path.dirname(path.dirname(kay.gw.book.workDir('t_probeprobe1', '')));
    writeFileSync(path.join(dir, 'files'), 'not a folder');
    const t = kay.gw.ask({ person: 'fixD2', ask: 'write it', by: 'agent' });
    await settle(() => task(kay, t.id)?.state === 'failed');
    expect(task(kay, t.id)?.result?.summary).toContain("couldn't be saved on this Mac");
  }, 60_000);

  it('Always whose rule can’t be saved fails (doesn’t hang); a file that can’t be read fails too', async () => {
    const blocker = path.join(scratch('d-rules'), 'a-file');
    writeFileSync(blocker, 'x');
    const shared = scratch('d-shared2');
    writeFileSync(path.join(shared, 'locked.txt'), 'secret-ish');
    chmodSync(path.join(shared, 'locked.txt'), 0o000);
    const [kay, bob] = await pair('fixE1', 'fixE2', {}, { rulesFile: path.join(blocker, 'rules.json'), loadCaps: () => ({ folders: [shared] }) });
    kay.trust(bob.id, 'trusted');
    const t = kay.gw.ask({ person: 'fixE2', ask: 'hello', by: 'agent' });
    await settle(() => bob.approvals.length === 1);
    bob.approvals[0]!.answer('always');
    await settle(() => task(kay, t.id)?.state === 'failed');
    expect(task(kay, t.id)?.result?.summary).toContain("the rule couldn't be saved");
    bob.trust(kay.id, 'trusted');
    const f = kay.gw.ask({ person: 'fixE2', kind: 'file', ask: '', path: path.join(shared, 'locked.txt'), by: 'agent' });
    await settle(() => task(kay, f.id)?.state === 'failed');
    expect(task(kay, f.id)?.result?.summary).toContain("couldn't read it");
    chmodSync(path.join(shared, 'locked.txt'), 0o600);
  }, 60_000);
});

describe('rules: their scope is what it says', () => {
  it('a rule’s folder is saved where it really is (~ expanded, links followed); Allow any command anywhere is refused', () => {
    const real = scratch('r-real');
    const link = path.join(scratch('r-link'), 'shortcut');
    symlinkSync(real, link);
    const book = new RuleBook({ file: null, loadCaps: () => undefined, saveCaps: () => undefined, onChange: () => undefined, now: Date.now });
    const saved = book.save({ peerId: 'kay-peer-00001', peerName: 'kay', kind: 'command', needs: [], folder: link, decision: 'allow' });
    expect(saved.folder).toBe(real);
    expect(realFolder('~/', os.homedir())).toBe(realpathSync.native(os.homedir()));
    expect(() => book.save({ peerId: 'kay-peer-00001', peerName: 'kay', kind: 'command', needs: [], decision: 'allow' })).toThrow('needs a folder or a project');
    expect(() => book.remember({ peerId: 'kay-peer-00001', kind: 'command', needs: ['shell'], command: 'ls' }, 'kay', { scope: 'any', command: 'any', expiry: 'never' })).toThrow('needs a folder or a project');
    // Narrowing is fine anywhere.
    expect(book.save({ peerId: 'kay-peer-00001', peerName: 'kay', kind: 'command', needs: [], decision: 'decline' }).decision).toBe('decline');
  });

  it('an unreadable rules file is put aside (not overwritten) and you’re told', () => {
    const dir = scratch('r-bad');
    const file = path.join(dir, 'rules.json');
    writeFileSync(file, '{ this is not json');
    const problems: string[] = [];
    const book = new RuleBook({ file, loadCaps: () => undefined, saveCaps: () => undefined, onChange: () => undefined, now: Date.now, onProblem: (title) => void problems.push(title) });
    expect(problems).toEqual(["Your rules couldn't be read"]);
    const aside = readdirSync(dir).find((f) => f.startsWith('rules.json.bad-'))!;
    expect(readFileSync(path.join(dir, aside), 'utf8')).toBe('{ this is not json');
    book.save({ peerId: 'kay-peer-00001', peerName: 'kay', kind: 'task', needs: [], decision: 'allow' });
    expect(readFileSync(path.join(dir, aside), 'utf8')).toBe('{ this is not json');
    expect(existsSync(file)).toBe(true);
  });
});

describe('before anything is said or kept', () => {
  it('a blocked person’s request leaves nothing here; an unknown project reads like one they can’t have', async () => {
    const dirs = { landing: scratch('p-landing') };
    const events: NoticeEvent[] = [];
    const [kay, bob] = await pair('fixF1', 'fixF2', {}, { projectRoot: (n) => dirs[n as 'landing'], notify: (e) => void events.push(e) });
    kay.trust(bob.id, 'trusted');
    bob.trust(kay.id, 'blocked');
    const t = kay.gw.ask({ person: 'fixF2', ask: 'hi', by: 'agent' });
    await settle(() => task(kay, t.id)?.state === 'declined');
    expect(bob.gw.book.all()).toHaveLength(0);
    bob.trust(kay.id, 'trusted');
    const unknown = kay.gw.ask({ person: 'fixF2', ask: 'look', project: 'secret-plans', needs: ['project'], by: 'agent' });
    await settle(() => task(kay, unknown.id)?.state === 'declined');
    expect(task(kay, unknown.id)?.result?.summary).toBe("That isn't available on fixF2's Mac");
    expect(bob.approvals).toHaveLength(0);
  }, 60_000);

  it('a request stopped while it was being looked at never starts', async () => {
    const dir = scratch('p-stop');
    let bob!: Node;
    const [kay, b] = await pair('fixG1', 'fixG2', {}, {
      projectRoot: () => {
        // You stop it right then (the moment it's looked up).
        const open = bob?.gw.book.all().find((x) => x.direction === 'received' && x.state === 'queued');
        if (open) bob.gw.cancel(open.id);
        return dir;
      },
    });
    bob = b;
    kay.trust(bob.id, 'trusted');
    // bob has kay on "Ask me each time": a stopped request must not ask him anything.
    const t = kay.gw.ask({ person: 'fixG2', ask: 'work in it', project: 'api', needs: ['project'], by: 'agent' });
    await settle(() => task(kay, t.id)?.state === 'cancelled');
    await new Promise((r) => setTimeout(r, 200));
    expect(bob.approvals).toHaveLength(0);
    expect(bob.claude.runs).toHaveLength(0);
  }, 60_000);
});

describe('results can be sent again whole', () => {
  it('a big file’s id and checksum are kept with the result', async () => {
    const [kay, bob] = await pair('fixH1', 'fixH2', {}, { system: pretendSystem({ big: true }) });
    kay.trust(bob.id, 'full');
    bob.trust(kay.id, 'full');
    bob.claude.answer = async (input) => {
      await input.taskTools!.screenshot!();
      return 'shot';
    };
    const t = kay.gw.ask({ person: 'fixH2', ask: 'screen', needs: ['screen'], by: 'agent' });
    await settle(() => task(kay, t.id)?.state === 'done');
    expect(task(bob, t.id)?.result?.files[0]).toMatchObject({ ref: expect.any(String), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  }, 60_000);
});
