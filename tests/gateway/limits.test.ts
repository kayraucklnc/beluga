import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CAPABILITIES } from '../../src/core/gateway/access.js';
import { pretendSystem } from '../../src/core/gateway/demo-system.js';
import { resumePrompt } from '../../src/core/gateway/result.js';
import { takesScreenshot } from '../../src/core/gateway/serve.js';
import { type Crowd, befriend, crowd, settle } from '../mesh/helpers.js';
import { type Node, node, task } from './helpers.js';

/**
 * A friend's request never runs on and on (BLG-427): turns and time, approvals asked, screenshots
 * by command, the asking Claude asking again, and how many requests one person may have open.
 */

let net: Crowd;
beforeAll(async () => {
  net = await crowd();
}, 30_000);
afterAll(async () => {
  await net?.close();
});

async function pair(a: string, b: string, extraB: Parameters<typeof node>[2] = {}): Promise<[Node, Node]> {
  const x = await node(net, a);
  const y = await node(net, b, extraB);
  await befriend(x.person, y.person);
  return [x, y];
}

/** Answer each tool approval as it comes, from a script (the last answer repeats). */
function answering(n: Node, answers: Array<'yes' | 'no'>): () => void {
  let next = 0;
  const timer = setInterval(() => {
    const tools = n.approvals.filter((p) => p.kind === 'tool');
    while (next < tools.length) tools[next]!.answer(answers[Math.min(next, answers.length - 1)]!), next++;
  }, 5);
  return () => clearInterval(timer);
}

describe('turns and time', () => {
  it('a friend’s task runs with a turn limit, and running out of turns says so', async () => {
    const [kay, bob] = await pair('limA1', 'limA2');
    kay.trust(bob.id, 'trusted');
    bob.trust(kay.id, 'trusted');
    bob.claude.answer = () => {
      throw new Error('Agent stopped: error max turns');
    };
    const t = kay.gw.ask({ person: 'limA2', ask: 'open this text full screen', by: 'agent' });
    await settle(() => task(kay, t.id)?.state === 'failed');
    expect(bob.claude.runs[0]!.maxTurns).toBe(50);
    expect(task(kay, t.id)?.result?.summary).toBe('Stopped after 50 turns');
  }, 60_000);

  it('a task that runs too long is stopped, and the requester hears why', async () => {
    const [kay, bob] = await pair('limB1', 'limB2', { runLimitMs: 2000 });
    kay.trust(bob.id, 'trusted');
    bob.trust(kay.id, 'trusted');
    bob.claude.hold();
    const t = kay.gw.ask({ person: 'limB2', ask: 'keep looking at the screen', by: 'agent' });
    await settle(() => task(kay, t.id)?.state === 'failed');
    expect(task(kay, t.id)?.result?.summary).toBe('Stopped after 2 seconds');
    expect(task(bob, t.id)?.state).toBe('failed');
  }, 60_000);

  it('its deadline stops it too, when that comes sooner', async () => {
    const [kay, bob] = await pair('limC1', 'limC2');
    kay.trust(bob.id, 'trusted');
    bob.trust(kay.id, 'trusted');
    bob.claude.hold();
    const t = kay.gw.ask({ person: 'limC2', ask: 'quick look', deadlineSec: 1, by: 'agent' });
    await settle(() => task(kay, t.id)?.state === 'failed');
    expect(task(kay, t.id)?.result?.summary).toBe('Stopped: its deadline passed');
  }, 60_000);
});

describe('approvals a task asks for', () => {
  it('at most 8; the next one stops the task instead of asking again', async () => {
    const [kay, bob] = await pair('limD1', 'limD2');
    kay.trust(bob.id, 'trusted');
    const allowed: boolean[] = [];
    bob.claude.answer = async (input) => {
      for (let i = 0; i < 12 && !input.signal.aborted; i++) allowed.push(await input.canUseTool('Bash', { command: `echo ${i}` }));
      return 'ok';
    };
    const t = kay.gw.ask({ person: 'limD2', ask: 'look around', by: 'agent' });
    await settle(() => bob.approvals.length === 1);
    bob.approvals[0]!.answer('yes');
    const off = answering(bob, ['yes']);
    await settle(() => task(kay, t.id)?.state === 'failed');
    off();
    expect(bob.approvals.filter((p) => p.kind === 'tool')).toHaveLength(8);
    expect(allowed).toEqual([...Array(8).fill(true), false]);
    expect(task(kay, t.id)?.result?.summary).toBe("Stopped: it needed limD2's approval more than 8 times. Ask for less at once, or ask limD2 to allow it");
  }, 60_000);

  it('two declines in a row stop it (a yes between them doesn’t)', async () => {
    const [kay, bob] = await pair('limE1', 'limE2');
    kay.trust(bob.id, 'trusted');
    const allowed: boolean[] = [];
    bob.claude.answer = async (input) => {
      for (let i = 0; i < 6 && !input.signal.aborted; i++) allowed.push(await input.canUseTool('Bash', { command: `open note.txt # ${i}` }));
      return 'ok';
    };
    const t = kay.gw.ask({ person: 'limE2', ask: 'open this text full screen', by: 'agent' });
    await settle(() => bob.approvals.length === 1);
    bob.approvals[0]!.answer('yes');
    const off = answering(bob, ['no', 'yes', 'no', 'no']);
    await settle(() => task(kay, t.id)?.state === 'declined');
    off();
    expect(allowed).toEqual([false, true, false, false]);
    expect(task(kay, t.id)?.result?.summary).toBe('Stopped: limE2 declined 2 of its steps in a row');
  }, 60_000);
});

describe('screenshots by command', () => {
  it('knows a command that takes a screenshot', () => {
    for (const command of ['screencapture -x /tmp/a.png', '/usr/sbin/screencapture -l1 a.png', 'cd /tmp && screencapture a.png', 'python3 -c "from PIL import ImageGrab; ImageGrab.grab()"', 'scrot out.png'])
      expect(takesScreenshot('Bash', { command }), command).toBe(true);
    for (const command of ['ls screenshots', 'cat screencapture.log', 'echo screencaptured', 'open note.txt'])
      expect(takesScreenshot('Bash', { command }), command).toBe(false);
    expect(takesScreenshot('Read', { command: 'screencapture' })).toBe(false);
  });

  it('need the screen, and count toward the 4 screenshots with the tool’s', async () => {
    const system = pretendSystem();
    const [kay, bob] = await pair('limF1', 'limF2', { system });
    kay.trust(bob.id, 'trusted');
    bob.trust(kay.id, 'full');
    const seen: Array<string | undefined> = [];
    const ok: boolean[] = [];
    const shoot = async (input: Parameters<typeof bob.claude.answer>[0]): Promise<void> => {
      const call = { command: 'screencapture -x /tmp/shot.png' };
      const veto = input.vetTool?.('Bash', call);
      seen.push(veto);
      if (!veto) ok.push(await input.canUseTool('Bash', call));
    };
    // Not asked for the screen: a command can't take one either.
    bob.claude.answer = async (input) => (await shoot(input), 'ok');
    const blind = kay.gw.ask({ person: 'limF2', ask: 'look around', by: 'agent' });
    await settle(() => task(kay, blind.id)?.state === 'done');
    expect(seen[0]).toContain("wasn't let in to see limF2's screen");

    // Asked for it: two with the tool, two by command, and then neither.
    seen.length = 0;
    bob.claude.answer = async (input) => {
      await input.taskTools!.screenshot!();
      await input.taskTools!.screenshot!();
      await shoot(input);
      await shoot(input);
      await shoot(input);
      await expect(input.taskTools!.screenshot!()).rejects.toThrow('At most 4 screenshots per request');
      return 'ok';
    };
    const look = kay.gw.ask({ person: 'limF2', ask: 'what is on screen?', needs: ['screen'], by: 'agent' });
    await settle(() => task(kay, look.id)?.state === 'done');
    expect(ok).toEqual([true, true]);
    expect(seen.slice(0, 2)).toEqual([undefined, undefined]);
    expect(seen[2]).toContain('At most 4 screenshots per request');
  }, 60_000);

  it('asks you when commands are allowed but the screen is Ask me', async () => {
    const [kay, bob] = await pair('limG1', 'limG2', { system: pretendSystem() });
    kay.trust(bob.id, 'trusted');
    bob.trust(kay.id, 'trusted');
    bob.gw.setCapabilities({ levels: { shell: { ...DEFAULT_CAPABILITIES.levels.shell, trusted: 'allow' }, screen: { ...DEFAULT_CAPABILITIES.levels.screen, trusted: 'allow' } } });
    const allowed: boolean[] = [];
    bob.claude.answer = async (input) => {
      allowed.push(await input.canUseTool('Bash', { command: 'ls' }));
      // The screen goes to Ask me while it works: a screenshot by command asks.
      bob.gw.setCapabilities({ levels: { screen: { ...DEFAULT_CAPABILITIES.levels.screen, trusted: 'ask' } } });
      allowed.push(await input.canUseTool('Bash', { command: 'screencapture -x /tmp/a.png' }));
      return 'ok';
    };
    const t = kay.gw.ask({ person: 'limG2', ask: 'what is on screen?', needs: ['screen'], by: 'agent' });
    await settle(() => bob.approvals.some((p) => p.kind === 'tool'));
    expect(bob.approvals.filter((p) => p.kind === 'tool')).toHaveLength(1);
    bob.approvals.find((p) => p.kind === 'tool')!.answer('yes');
    await settle(() => task(kay, t.id)?.state === 'done');
    expect(allowed).toEqual([true, true]);
  }, 60_000);
});

describe('your Claude asking again', () => {
  it('one conversation’s Claude asks the same person at most 3 times in 10 minutes', async () => {
    const [kay, bob] = await pair('limH1', 'limH2');
    kay.trust(bob.id, 'trusted');
    bob.claude.hold();
    for (let i = 0; i < 3; i++) kay.gw.ask({ person: 'limH2', ask: `open this text full screen (${i})`, by: 'agent', conversation: 'ws:abc' });
    expect(() => kay.gw.ask({ person: 'limH2', ask: 'open this text full screen, again', by: 'agent', conversation: 'ws:abc' })).toThrow(/You already sent limH2 3 requests from this conversation in the last 10 minutes\. Don't ask again: stop, and tell your user/);
    // Another conversation, you yourself, or a file: not held back.
    expect(() => kay.gw.ask({ person: 'limH2', ask: 'something else', by: 'agent', conversation: 'ws:other' })).not.toThrow();
    expect(() => kay.gw.ask({ person: 'limH2', ask: 'from me', by: 'person', conversation: 'ws:abc' })).not.toThrow();
    expect(() => kay.gw.ask({ person: 'limH2', kind: 'file', ask: '', path: '/tmp/notes.txt', by: 'agent', conversation: 'ws:abc' })).not.toThrow();
    bob.claude.open();
  }, 60_000);

  it('a result your Claude hears later tells it not to send the same ask again', () => {
    const prompt = resumePrompt({ id: 't_abcdefghij12', direction: 'sent', peerId: 'p', peerName: 'alice', kind: 'ask', ask: 'open it', needs: [], by: 'agent', state: 'failed', steps: [], createdAt: 1, updatedAt: 1, result: { status: 'failed', summary: 'Stopped after 20 minutes', files: [], log: [] } });
    expect(prompt).toContain("Don't send the same ask again");
    expect(prompt).not.toContain('you can ask again');
  });
});

describe('requests one person may have open', () => {
  it('5 at most: the sixth is declined', async () => {
    const [kay, bob] = await pair('limI1', 'limI2');
    kay.trust(bob.id, 'trusted');
    bob.trust(kay.id, 'trusted');
    bob.claude.hold();
    const sent = Array.from({ length: 6 }, (_, i) => kay.gw.ask({ person: 'limI2', ask: `job ${i}`, by: 'person' }));
    await settle(() => task(kay, sent[5]!.id)?.state === 'declined');
    expect(task(kay, sent[5]!.id)?.result?.summary).toBe("Too many of your requests are already waiting on limI2's Mac; try again when they're done");
    await settle(() => sent.slice(0, 5).every((t) => ['working', 'queued'].includes(task(bob, t.id)?.state ?? '')));
    expect(bob.gw.book.all().filter((t) => t.direction === 'received' && !['declined', 'failed', 'done', 'cancelled'].includes(t.state))).toHaveLength(5);
    bob.claude.open();
  }, 60_000);
});
