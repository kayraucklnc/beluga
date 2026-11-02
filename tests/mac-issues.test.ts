import { describe, expect, it } from 'vitest';
import { agoWords, comments, issuesProject, labelColor, lastReport, readIssuesPrefs, searchWords, stateOf } from '../packages/mac/src/issues/issues-model.js';
import type { LogItem } from '../src/core/store.js';

/** The Mac's Issues screens, their plain parts: states, label colors, prefs, the project shown, Claude's report. */

describe('Issues on the Mac', () => {
  it('says an issue’s state as GitHub does', () => {
    expect(stateOf({ state: 'open' })).toEqual({ label: 'Open', tone: 'open' });
    expect(stateOf({ state: 'closed', reason: 'completed' })).toEqual({ label: 'Closed', tone: 'done' });
    expect(stateOf({ state: 'closed' })).toEqual({ label: 'Closed', tone: 'done' });
    expect(stateOf({ state: 'closed', reason: 'not_planned' })).toEqual({ label: 'Not planned', tone: 'muted' });
    expect(stateOf({ state: 'closed', reason: 'duplicate' }).tone).toBe('muted');
  });

  it('tints labels with GitHub’s own colors (grey when there’s none)', () => {
    expect(labelColor('D73A4A')).toBe('#d73a4a');
    expect(labelColor('')).toBeUndefined();
    expect(labelColor('red')).toBeUndefined();
  });

  it('remembers open or closed, and shows the project asked for, else the last one, else the first', () => {
    expect(readIssuesPrefs('{"state":"closed"}')).toEqual({ state: 'closed' });
    expect(readIssuesPrefs('nonsense')).toEqual({ state: 'open' });
    expect(readIssuesPrefs(null)).toEqual({ state: 'open' });
    const projects: Array<{ id: string; root: string; error?: string }> = [{ id: 'chats', root: '' }, { id: 'a', root: '/a' }, { id: 'b', root: '/b' }, { id: 'broken', root: '/c', error: 'gone' }];
    expect(issuesProject(projects, 'b', 'a')).toBe('b');
    expect(issuesProject(projects, 'broken', 'a')).toBe('a');
    expect(issuesProject(projects, undefined, 'nope')).toBe('a');
    expect(issuesProject([], undefined, undefined)).toBeUndefined();
  });

  it('words', () => {
    expect(comments(1)).toBe('1 comment');
    expect(comments(3)).toBe('3 comments');
    expect(searchWords('  login   500 ')).toBe('login 500');
    const now = Date.parse('2026-10-25T12:00:00Z');
    expect(agoWords(now - 30 * 3600_000, now)).toBe('yesterday');
    expect(agoWords(now - 5 * 60_000, now)).toBe('5 min ago');
  });

  it('finds Claude’s last report in a conversation (not a question, not another conversation)', () => {
    const agent = (channel: string, status: string, text: string) => ({ type: 'agent', channel, status, text, subagents: [], requestId: text, owner: 'me', ownerName: 'Kay', requesterName: 'Kay', steps: [], ts: 0 }) as unknown as LogItem;
    const log = [agent('ws:w1', 'done', 'First report'), agent('ws:w2', 'done', 'Elsewhere'), agent('ws:w1', 'done', '**Why:** found it'), agent('ws:w1', 'started', 'Working…')];
    expect(lastReport(log, 'ws:w1')).toBe('**Why:** found it');
    expect(lastReport(log, 'ws:w3')).toBeUndefined();
    expect(lastReport([agent('ws:w1', 'done', '(done)')], 'ws:w1')).toBeUndefined();
  });
});
