import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRunInput } from '../src/agent/types.js';
import { launchAssistant } from '../src/core/assistant/launch.js';
import { assistantOf } from '../src/core/assistant/registry.js';
import { schedulesOf } from '../src/core/schedule/registry.js';
import { assistantChannel } from '../src/shared/assistant.js';
import { RunFailedError, classifyRun, decodeFailure, failureTitle } from '../src/shared/run-failure.js';
import { waitFor } from './helpers.js';
import { harness, type Harness } from './schedule-fakes.js';

const MIN = 60_000;
const EVERY_MINUTE = { title: 'Check', prompt: 'Look at it', when: { kind: 'interval', minutes: 1 } } as const;
const CLAUDE_WORDS = 'Claude Code process exited with code 1. stderr: No conversation found with session ID: 8f2c';

let h: Harness;

beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.close();
});

async function runOnce(channel: string, id: string): Promise<void> {
  const s = schedulesOf(h.session)!;
  h.clock.now += 2 * MIN;
  s.tick();
  await waitFor(() => !s.get(id)?.running && !h.session.host.busyIn(channel), 4000);
}

/** The fake agent can't find a session it was told to resume, for runs that resume `gone`. */
function goneSession(gone: (input: AgentRunInput) => boolean) {
  h.script.run = async (input) => {
    if (gone(input)) throw new RunFailedError(classifyRun({ error: CLAUDE_WORDS, resumed: true }));
    return 'the report';
  };
}

describe('detecting a stale session', () => {
  it('marks a resumed run whose session is gone, in a thrown error and in a failed turn', () => {
    expect(classifyRun({ error: CLAUDE_WORDS, resumed: true }).staleSession).toBe(true);
    expect(classifyRun({ result: 'No conversation found with session ID: 8f2c', resumed: true }).staleSession).toBe(true);
    expect(classifyRun({ error: 'exited with code 1', stderr: ['No conversation found with session ID: 8f2c'], resumed: true }).staleSession).toBe(true);
  });

  it('does not mark a run that resumed nothing, or another failure', () => {
    expect(classifyRun({ error: CLAUDE_WORDS }).staleSession).toBeUndefined();
    expect(classifyRun({ error: 'Claude Code process exited with code 1', resumed: true }).staleSession).toBeUndefined();
    expect(classifyRun({ error: 'connect ECONNRESET. No conversation found with session ID: 8f2c', resumed: true }).staleSession).toBeUndefined();
  });

  it('keeps the kind and the words of the failure, and the mark survives the card', () => {
    const marked = classifyRun({ error: CLAUDE_WORDS, resumed: true }, 0);
    const before = classifyRun({ error: CLAUDE_WORDS }, 0);
    expect(marked.kind).toBe(before.kind);
    expect(marked.exitCode).toBe(before.exitCode);
    expect(failureTitle(marked, 0)).toBe(failureTitle(before, 0));
    expect(decodeFailure(new RunFailedError(marked).message)?.staleSession).toBe(true);
  });
});

describe('a scheduled run on a stale session', () => {
  it('retries once in a new session with the recent chat, then runs as normal, with no failure counted', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, EVERY_MINUTE);
    let goneOnce = true;
    await runOnce(channel, made.id);
    goneSession((input) => {
      const gone = goneOnce && Boolean(input.place?.resume);
      if (gone) goneOnce = false;
      return gone;
    });

    await runOnce(channel, made.id);

    expect(h.runs.map((r) => r.place?.resume)).toEqual([undefined, 'session-1', undefined]);
    expect(h.runs[2]!.prompt).toMatch(/<conversation>[\s\S]*<\/conversation>\s+Look at it$/);
    expect(h.lines(channel).filter((l) => /could not be resumed/.test(l))).toHaveLength(1);
    expect(s.get(made.id)).toMatchObject({ last: 'ok', failures: 0, enabled: true });

    await runOnce(channel, made.id);
    expect(h.runs).toHaveLength(4);
    expect(h.runs[3]!.place?.resume).toBe('session-3');
    expect(h.runs[3]!.prompt).toBe('Look at it');
    expect(s.get(made.id)).toMatchObject({ last: 'ok', failures: 0 });
  });

  it('works in a Your Mac chat', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const stop = launchAssistant({ session: h.session, store: h.store, demo: true });
    try {
      const channel = assistantChannel(assistantOf(h.session)!.newChat());
      const made = s.create(channel, EVERY_MINUTE);
      await runOnce(channel, made.id);
      let goneOnce = true;
      goneSession((input) => {
        const gone = goneOnce && Boolean(input.place?.resume);
        if (gone) goneOnce = false;
        return gone;
      });

      await runOnce(channel, made.id);

      expect(h.runs.map((r) => Boolean(r.place?.resume))).toEqual([false, true, false]);
      expect(h.runs[2]!.prompt).toMatch(/<conversation>/);
      expect(s.get(made.id)).toMatchObject({ last: 'ok', failures: 0 });
    } finally {
      stop();
    }
  });

  it('retries only once: a second stale failure counts as one failed run', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, EVERY_MINUTE);
    await runOnce(channel, made.id);
    goneSession(() => true);

    await runOnce(channel, made.id);

    expect(h.runs).toHaveLength(3);
    expect(s.get(made.id)).toMatchObject({ last: 'failed', failures: 1 });
  });

  it('counts another failure as before, with no retry', { timeout: 30_000 }, async () => {
    const s = h.launch();
    const channel = await h.chat();
    const made = s.create(channel, EVERY_MINUTE);
    await runOnce(channel, made.id);
    h.script.run = async () => {
      throw new RunFailedError(classifyRun({ error: 'Claude Code process exited with code 1', resumed: true }));
    };

    await runOnce(channel, made.id);

    expect(h.runs).toHaveLength(2);
    expect(h.runs[1]!.place?.resume).toBe('session-1');
    expect(s.get(made.id)).toMatchObject({ last: 'failed', failures: 1 });
  });
});

describe('a user message on a stale session', () => {
  it('fails as it did before: no retry, no line, the same words, and the session stays', { timeout: 30_000 }, async () => {
    h.launch();
    const channel = await h.chat();
    const failedCards = () => h.store.getState().log.filter((l) => l.channel === channel && l.type === 'agent' && l.status === 'error');
    const quiet = () => waitFor(() => !h.session.host.busyIn(channel), 4000);

    h.session.askOwnClaude('hello', channel);
    await waitFor(() => h.runs.length === 1, 4000);
    await quiet();
    goneSession((input) => Boolean(input.place?.resume));

    h.session.askOwnClaude('and now?', channel);
    await waitFor(() => failedCards().length === 1, 4000);
    await quiet();

    expect(h.runs).toHaveLength(2);
    expect(h.runs[1]!.prompt).toBe('and now?');
    expect(h.lines(channel).filter((l) => /could not be resumed/.test(l))).toEqual([]);
    const card = failedCards()[0]!;
    const failure = decodeFailure(card.type === 'agent' ? card.text : '');
    expect(failure?.kind).toBe('crash');
    expect(failure && failureTitle(failure)).toBe('Claude Code stopped unexpectedly (exit 1)');

    h.script.run = async () => 'back';
    h.session.askOwnClaude('again', channel);
    await waitFor(() => h.runs.length === 3, 4000);
    await quiet();
    expect(h.runs[2]!.place?.resume).toBe('session-1');
    expect(h.runs[2]!.prompt).toBe('again');
  });
});
