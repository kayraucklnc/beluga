import { describe, expect, it } from 'vitest';
import { type DiagnoseInput, attemptLine, diagnose, pathLabel, pathNote } from '../src/companion/diagnose.js';
import type { DialAttempt } from '../src/companion/protocol.js';

const p2p = (outcome: DialAttempt['outcome'], code?: string): DialAttempt => ({ way: 'p2p', outcome, ...(code ? { code } : {}), ms: 2400 });
const relay = (outcome: DialAttempt['outcome'], code?: string): DialAttempt => ({ way: 'relay', outcome, ...(code ? { code } : {}), ms: 3100 });
const report = (tried: DialAttempt[], dht: 'ok' | 'unreachable' | 'unknown', found: 'yes' | 'no' | 'unknown', recordAge?: number): DiagnoseInput['report'] => ({ tried, dht, found, ...(recordAge !== undefined ? { recordAge } : {}) });
const problem = (input: DiagnoseInput): string => diagnose(input).problem;

describe('what went wrong, in words', () => {
  it('says the phone is offline before blaming the Mac', () => {
    expect(problem({ stage: 'link', online: false, report: report([p2p('timeout'), relay('unreachable')], 'unreachable', 'unknown') })).toBe('offline');
  });

  it('tells a network that blocks the DHT from a Mac that isn’t there', () => {
    expect(problem({ stage: 'link', online: true, report: report([p2p('timeout'), relay('skipped', 'NO_RELAY')], 'unreachable', 'unknown') })).toBe('dht-blocked');
    expect(problem({ stage: 'link', online: true, report: report([p2p('not-found', 'PEER_NOT_FOUND'), relay('skipped', 'NO_RELAY')], 'ok', 'no') })).toBe('mac-offline');
    // An old relay record and nothing answering: the Mac went away a while ago.
    expect(problem({ stage: 'link', online: true, report: report([p2p('timeout'), relay('not-found', '530')], 'ok', 'unknown', 3 * 3600_000) })).toBe('mac-offline');
  });

  it('says the Mac is there but this network won’t connect them (Kayra’s dorm Wi-Fi)', () => {
    const d = diagnose({ stage: 'pair', online: true, report: report([p2p('unreachable', 'HOLEPUNCH_ABORTED'), relay('unreachable')], 'ok', 'yes') });
    expect(d.problem).toBe('no-path');
    expect(d.tryThis).toMatch(/mobile data/);
    expect(d.retry).toBe(true);
    // The codes are in the "Why?" sheet, never on the surface.
    expect(`${d.title} ${d.body} ${d.tryThis}`).not.toMatch(/HOLEPUNCH|[A-Z]{4,}_/);
    expect(d.detail[0]).toBe('Direct connection: found the Mac, but couldn’t connect on this network (2.4 s · HOLEPUNCH_ABORTED)');
  });

  it('knows pairings that are closed, used, wrong or full', () => {
    expect(problem({ stage: 'pair', online: true, report: report([p2p('not-found', 'PEER_NOT_FOUND'), relay('skipped', 'NO_RELAY')], 'ok', 'no') })).toBe('pairing-gone');
    expect(problem({ stage: 'pair', refusal: 'expired' })).toBe('pairing-gone');
    expect(diagnose({ stage: 'pair', refusal: 'used' }).body).toMatch(/one phone/);
    expect(problem({ stage: 'pair', refusal: 'unverified' })).toBe('pairing-wrong');
    expect(problem({ stage: 'pair', refusal: 'full' })).toBe('pairing-full');
    expect(problem({ stage: 'pair', refusal: 'busy' })).toBe('pairing-busy');
  });

  it('asks for the right update, and knows a removed phone', () => {
    expect(problem({ stage: 'link', closeCode: 4002, reason: 'Update Beluga on your Mac' })).toBe('update-mac');
    expect(problem({ stage: 'link', closeCode: 4002, reason: 'Update the Beluga app' })).toBe('update-app');
    expect(problem({ stage: 'pair', refusal: 'version-mac' })).toBe('update-mac');
    expect(diagnose({ stage: 'link', closeCode: 4010 })).toMatchObject({ problem: 'removed', action: 'pair-again', retry: false });
  });

  it('falls back to a plain "didn’t answer"', () => {
    expect(problem({ stage: 'link' })).toBe('unknown');
  });
});

describe('the path, in words', () => {
  it('labels and notes how a link came', () => {
    expect(pathLabel('lan')).toBe('Connected directly · same network');
    expect(pathLabel('direct')).toBe('Connected directly · over the internet');
    expect(pathLabel('relay')).toBe('Connected through the relay (end-to-end encrypted)');
    expect(pathNote('relay', [p2p('unreachable', 'HOLEPUNCH_ABORTED'), relay('ok')])).toMatch(/^Your phone found this Mac but couldn’t connect directly on its network, so it used the relay/);
    expect(pathNote('relay', [relay('ok')])).toMatch(/straight to the relay/);
    expect(pathNote('relay', [p2p('timeout'), relay('ok')])).toMatch(/couldn’t reach this Mac directly/);
    expect(attemptLine(relay('lost'))).toBe('Relay: stopped: another way connected first (3.1 s)');
  });
});
