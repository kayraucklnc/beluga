import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Capabilities, DEFAULT_CAPABILITIES, type RequestFacts, type Rule, capabilitiesFrom, decideAccess, declineReason, expiryLabel, offersFor, ruleFor, ruleLabel, ruleMatches, scopeChoices, within } from '../../src/core/gateway/access.js';
import { RuleBook } from '../../src/core/gateway/rule-book.js';

/** Rules and capabilities: who may have their Claude do what here, decided in a fixed order. */

const NOW = 1_800_000_000_000;
const KAY = 'kay-peer-id-0001';
const rule = (r: Partial<Rule>): Rule => ({ id: 'r_test0001', peerId: KAY, peerName: 'kay', kind: 'task', needs: [], decision: 'allow', createdAt: NOW - 1000, ...r });
const task = (f: Partial<RequestFacts> = {}): RequestFacts => ({ peerId: KAY, kind: 'task', needs: [], ...f });
const decide = (trust: string, facts: RequestFacts, rules: Rule[] = [], caps: Capabilities = DEFAULT_CAPABILITIES) => decideAccess({ trust, caps, rules, facts, now: NOW });

describe('deciding a request', () => {
  it('blocked people are declined, whatever the rules', () => {
    expect(decide('blocked', task(), [rule({})])).toMatchObject({ verdict: 'decline', by: 'blocked' });
  });

  it('a capability that is off declines first, even over an allow rule, saying which', () => {
    const screenOff: Capabilities = { ...DEFAULT_CAPABILITIES, levels: { ...DEFAULT_CAPABILITIES.levels, screen: { ask: 'off', trusted: 'ask', full: 'allow' } } };
    const d = decide('ask', task({ needs: ['screen'] }), [rule({ needs: ['screen'] })], screenOff);
    expect(d).toMatchObject({ verdict: 'decline', by: 'capability', caps: ['screen'] });
    expect(declineReason(d, 'bob')).toBe("bob's Beluga doesn't let you see the screen");
  });

  it('trust decides first for trusted and full trust when every capability it needs is Allow', () => {
    expect(decide('trusted', task({ needs: ['files', 'device'] }))).toMatchObject({ verdict: 'allow', by: 'trust' });
    expect(decide('full', task({ needs: ['screen', 'shell'] }))).toMatchObject({ verdict: 'allow', by: 'trust' });
    // A capability set to "Ask me" still asks, for trusted people too…
    expect(decide('trusted', task({ needs: ['screen'] }))).toMatchObject({ verdict: 'ask', by: 'default', caps: ['screen'] });
    expect(decide('trusted', { peerId: KAY, kind: 'command', needs: [], command: 'npm test' })).toMatchObject({ verdict: 'ask' });
    // …unless an allow rule covers it.
    expect(decide('trusted', task({ needs: ['screen'] }), [rule({ needs: ['screen'] })])).toMatchObject({ verdict: 'allow', by: 'rule' });
  });

  it('"Ask me each time" asks unless an allow rule covers the request', () => {
    expect(decide('ask', task())).toMatchObject({ verdict: 'ask', by: 'default' });
    expect(decide('ask', task(), [rule({})])).toMatchObject({ verdict: 'allow', by: 'rule' });
    // The rule allows no more than it lists.
    expect(decide('ask', task({ needs: ['shell'] }), [rule({})])).toMatchObject({ verdict: 'ask' });
  });

  it('decline and ask rules narrow trust (they apply even to people you trust); decline wins over ask', () => {
    expect(decide('full', task({ needs: ['shell'] }), [rule({ decision: 'decline', needs: ['shell'] })])).toMatchObject({ verdict: 'decline', by: 'rule' });
    expect(decide('trusted', task(), [rule({ decision: 'ask' })])).toMatchObject({ verdict: 'ask', by: 'rule' });
    expect(decide('trusted', task(), [rule({ decision: 'ask' }), rule({ id: 'r_test0002', decision: 'decline' }), rule({ id: 'r_test0003' })])).toMatchObject({ verdict: 'decline' });
    expect(declineReason(decide('full', task(), [rule({ decision: 'decline' })]), 'bob')).toBe('bob has a rule that declines requests like this one');
    // A decline rule for the screen doesn't touch a request that doesn't need it.
    expect(decide('trusted', task({ needs: ['files'] }), [rule({ decision: 'decline', needs: ['screen'] })])).toMatchObject({ verdict: 'allow', by: 'trust' });
  });

  it('your own requests always go through', () => {
    expect(decideAccess({ trust: 'blocked', caps: DEFAULT_CAPABILITIES, rules: [], facts: task(), now: NOW, self: true })).toMatchObject({ verdict: 'allow', by: 'self' });
  });
});

describe('rules: scope and expiry', () => {
  it('a project rule only covers that project; a request naming a project needs a rule that allows projects', () => {
    const r = rule({ needs: ['project'], project: 'landing' });
    expect(ruleMatches(r, task({ project: 'landing' }), NOW)).toBe(true);
    expect(ruleMatches(r, task({ project: 'api' }), NOW)).toBe(false);
    // A rule for scratch-folder requests (needs nothing) doesn't let a project request in.
    expect(ruleMatches(rule({}), task({ project: 'landing' }), NOW)).toBe(false);
    // "Any project".
    expect(ruleMatches(rule({ needs: ['project'] }), task({ project: 'api' }), NOW)).toBe(true);
  });

  it('a folder rule covers the folder and what is inside, not a sibling with a longer name', () => {
    const r = rule({ kind: 'command', folder: '/Users/bob/api' });
    const cmd = (folder: string): RequestFacts => ({ peerId: KAY, kind: 'command', needs: ['shell'], command: 'ls', folder });
    expect(ruleMatches(r, cmd('/Users/bob/api'), NOW)).toBe(true);
    expect(ruleMatches(r, cmd('/Users/bob/api/src'), NOW)).toBe(true);
    expect(ruleMatches(r, cmd('/Users/bob/api-old'), NOW)).toBe(false);
    expect(within('/', '/anything')).toBe(true);
  });

  it('a command rule covers that exact command (or any, when it names none); other people never', () => {
    const facts = (command: string): RequestFacts => ({ peerId: KAY, kind: 'command', needs: ['shell'], command });
    expect(ruleMatches(rule({ kind: 'command', command: 'npm test' }), facts(' npm test '), NOW)).toBe(true);
    expect(ruleMatches(rule({ kind: 'command', command: 'npm test' }), facts('npm test && rm -rf ~'), NOW)).toBe(false);
    expect(ruleMatches(rule({ kind: 'command' }), facts('anything'), NOW)).toBe(true);
    expect(ruleMatches(rule({ kind: 'command' }), { ...facts('ls'), peerId: 'someone-else-01' }, NOW)).toBe(false);
    expect(ruleMatches(rule({ kind: 'task' }), facts('ls'), NOW)).toBe(false);
  });

  it('an expired rule no longer applies', () => {
    expect(ruleMatches(rule({ expiresAt: NOW - 1 }), task(), NOW)).toBe(false);
    expect(ruleMatches(rule({ expiresAt: NOW + 60_000 }), task(), NOW)).toBe(true);
    expect(decide('ask', task(), [rule({ expiresAt: NOW - 1 })])).toMatchObject({ verdict: 'ask' });
    expect(expiryLabel({ expiresAt: NOW - 1 }, NOW)).toBe('expired');
    expect(expiryLabel({}, NOW)).toBe('never expires');
  });

  it('"Always" writes a rule matching the request: person, kind, needs, project (or anywhere), expiry', () => {
    const facts = task({ needs: ['shell'], project: 'landing' });
    const here = ruleFor(facts, 'kay', { scope: 'this', command: 'this', expiry: 'day' }, NOW, 'r_fromreq01');
    expect(here).toMatchObject({ peerId: KAY, kind: 'task', needs: ['shell', 'project'], project: 'landing', decision: 'allow', expiresAt: NOW + 86_400_000 });
    const anywhere = ruleFor(facts, 'kay', { scope: 'any', command: 'this', expiry: 'never' }, NOW, 'r_fromreq02');
    expect(anywhere.project).toBeUndefined();
    expect(anywhere.expiresAt).toBeUndefined();
    expect(ruleMatches(anywhere, task({ needs: ['shell'], project: 'api' }), NOW)).toBe(true);
    const cmd = ruleFor({ peerId: KAY, kind: 'command', needs: ['shell'], command: 'npm test', folder: '/p/api' }, 'kay', { scope: 'this', command: 'this', expiry: 'week' }, NOW, 'r_fromreq03');
    expect(cmd).toMatchObject({ kind: 'command', command: 'npm test', folder: '/p/api', needs: [] });
    expect(ruleLabel(here)).toBe('Requests to your agent that need at most: run commands, work in your projects · in landing');
    expect(ruleLabel(cmd)).toBe('The command `npm test` · in /p/api');
    expect(scopeChoices(facts)).toEqual({ this: 'Only in landing', any: 'In any project' });
    expect(scopeChoices(task())).toBeUndefined();
  });
});

describe('capabilities', () => {
  it('fills in defaults for anything missing or malformed, and offers by trust', () => {
    const caps = capabilitiesFrom({ levels: { screen: { ask: 'off', trusted: 'allow', full: 'allow' }, shell: { ask: 'maybe' } }, folders: ['/Users/bob/Shared'] });
    expect(caps.levels.screen.trusted).toBe('allow');
    expect(caps.levels.shell).toEqual(DEFAULT_CAPABILITIES.levels.shell);
    expect(caps.folders).toEqual(['/Users/bob/Shared']);
    expect(capabilitiesFrom(undefined)).toEqual(DEFAULT_CAPABILITIES);
    // Everything asks for someone on "Ask me each time" (the screen too: you see who and why first).
    expect(offersFor(DEFAULT_CAPABILITIES, 'ask')).toEqual(['project', 'shell', 'files', 'screen', 'device']);
    expect(offersFor(DEFAULT_CAPABILITIES, 'trusted')).toEqual(['project', 'shell', 'files', 'screen', 'device']);
    expect(offersFor(DEFAULT_CAPABILITIES, 'blocked')).toEqual([]);
  });
});

describe('the rule book', () => {
  it('keeps rules in a file only you can read, drops expired ones, saves capabilities to settings', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-rules-'));
    const file = path.join(dir, 'rules.json');
    let now = NOW;
    let savedCaps: Capabilities | undefined;
    const changes: number[] = [];
    const deps = { file, loadCaps: () => savedCaps, saveCaps: (c: Capabilities) => void (savedCaps = c), onChange: (rules: readonly Rule[]) => void changes.push(rules.length), now: () => now };
    const book = new RuleBook(deps);
    const kept = book.remember(task({ needs: ['files'] }), 'kay', { scope: 'this', command: 'this', expiry: 'never' });
    book.remember(task({ needs: ['files'] }), 'kay', { scope: 'this', command: 'this', expiry: 'day' });
    // The same rule again replaces it (with the new expiry) rather than piling up.
    expect(book.rules()).toHaveLength(1);
    expect(book.rules()[0]!.expiresAt).toBe(NOW + 86_400_000);
    const edited = book.save({ ...book.rules()[0]!, decision: 'ask' });
    expect(edited.id).not.toBe(kept.id);
    expect(book.rules()[0]!.decision).toBe('ask');
    expect(() => book.save({ peerId: KAY, peerName: 'kay', kind: 'task', needs: [], decision: 'allow', expiresAt: NOW - 5 })).toThrow('past');
    // Windows has no Unix modes: the user profile's own ACL keeps it private there.
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1, rules: [{ decision: 'ask' }] });
    // A day later it's gone, here and in the file.
    now += 86_400_001;
    const again = new RuleBook(deps);
    expect(again.rules()).toHaveLength(0);
    expect(JSON.parse(readFileSync(file, 'utf8')).rules).toHaveLength(0);
    again.setCapabilities({ levels: { screen: { ask: 'off', trusted: 'allow', full: 'allow' } }, folders: ['/tmp/shared'] });
    expect(savedCaps?.levels.screen.trusted).toBe('allow');
    expect(new RuleBook(deps).capabilities().folders).toEqual(['/tmp/shared']);
    expect(changes.length).toBeGreaterThan(3);
    expect(again.remove('r_nothere01')).toBe(false);
  });
});
