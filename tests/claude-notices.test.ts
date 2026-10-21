import { describe, expect, it } from 'vitest';
import type { LogItem } from '../src/core/store.js';
import { backgroundWait, isLimitNotice } from '../src/shared/claude-notices.js';

describe('isLimitNotice', () => {
  it("knows Claude Code's limit notices, not answers that talk about limits", () => {
    for (const t of ["You've hit your limit · resets 3pm (Europe/Istanbul)", 'You’ve hit your session limit · resets 9pm', 'Claude AI usage limit reached|1760000000', '5-hour limit reached ∙ resets 9pm', 'Done so far.\n\nWeekly limit reached ∙ resets Oct 24']) expect(isLimitNotice(t)).toBe(true);
    for (const t of ['', 'The rate limiter allows 60 requests a minute.', 'Fixed it: the session limit reached its max because of a bug, now it resets correctly and everything is fine and tested and documented in the README which explains the whole thing at great length, far longer than any notice Claude Code would print at all ever.']) expect(isLimitNotice(t)).toBe(false);
  });
});

describe('backgroundWait', () => {
  const card = (over: Partial<Extract<LogItem, { type: 'agent' }>>): LogItem => ({ id: 'a', type: 'agent', channel: 'ws:1', requestId: 'r', owner: 'me', ownerName: 'me', requesterName: 'me', status: 'started', text: 'Started two jobs.', steps: [], subagents: [], ts: 1, ...over });
  const sub = (title: string, status: 'running' | 'done', kind?: 'background') => ({ id: title, title, steps: [], status, ...(kind ? { kind } : {}) });

  it('says what an answered turn still waits on, and nothing once it all came back', () => {
    expect(backgroundWait([card({ subagents: [sub('Explore · auth', 'running'), sub('run tests', 'running'), sub('old', 'done')] })])).toBe('Waiting on 2 background agents · Explore · auth, run tests');
    expect(backgroundWait([card({ subagents: [sub('npm run build', 'running', 'background')] })])).toBe('Waiting on 1 background task · npm run build');
    expect(backgroundWait([card({ subagents: [sub('a', 'done')] })])).toBeUndefined();
    // Still working on its answer (its steps show that), or finished.
    expect(backgroundWait([card({ text: '', subagents: [sub('a', 'running')] })])).toBeUndefined();
    expect(backgroundWait([card({ status: 'done', subagents: [sub('a', 'running')] })])).toBeUndefined();
  });
});
