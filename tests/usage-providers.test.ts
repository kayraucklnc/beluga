import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { usageFor, usagesOf, withUsage } from '../src/agent/usage.js';
import { CLAUDE_AGENT, PeerInfo, Profile } from '../src/protocol.js';

/** The Profile an older Mac (before per-provider usage) parses frames with. */
const OldWindow = z.object({ pct: z.number().min(0).max(100), resetsAt: z.number().optional() });
const OldUsage = z.object({ plan: z.string().max(32).optional(), fiveHour: OldWindow.optional(), week: OldWindow.optional(), updatedAt: z.number() });
const OldProfile = z.object({
  name: z.string().regex(/^[\w.-]{1,32}$/),
  shares: z.array(z.object({ name: z.string(), writable: z.boolean() })).max(32),
  agent: z.boolean(),
  usage: OldUsage.optional(),
  projects: z.array(z.string().max(80)).max(60).optional(),
});
const OldPeerInfo = OldProfile.extend({ peerId: z.string().min(1).max(256), host: z.boolean().optional(), guest: z.boolean().optional() });

const codex = { runtime: 'codex', label: 'Codex' };
const local = { runtime: 'local', model: 'qwen3', label: 'Qwen' };

describe('usage per provider', () => {
  const base = { name: 'kay', shares: [], agent: true };

  it('merges each update into its own provider and keeps the old field Claude’s', () => {
    let p: Profile = { ...base };
    p = { ...p, ...withUsage(p, CLAUDE_AGENT, { plan: 'max', fiveHour: { pct: 12 } }, 1) };
    p = { ...p, ...withUsage(p, codex, { windows: [{ label: 'Weekly', pct: 30 }] }, 2) };
    p = { ...p, ...withUsage(p, local, { tokens: { input: 900, output: 300 }, tokensPerSec: 41 }, 3) };
    p = { ...p, ...withUsage(p, CLAUDE_AGENT, { week: { pct: 40 } }, 4) };
    expect(usagesOf(p).map((u) => u.agent.runtime)).toEqual(['claude', 'codex', 'local']);
    expect(usageFor(p, 'claude')).toMatchObject({ plan: 'max', fiveHour: { pct: 12 }, week: { pct: 40 }, updatedAt: 4 });
    expect(usageFor(p, 'codex')).toMatchObject({ windows: [{ label: 'Weekly', pct: 30 }], updatedAt: 2 });
    expect(usageFor(p, 'codex')?.fiveHour).toBeUndefined();
    expect(usageFor(p, 'local')).toMatchObject({ agent: local, tokensPerSec: 41 });
    expect(p.usage).toEqual({ plan: 'max', fiveHour: { pct: 12 }, week: { pct: 40 }, updatedAt: 4 });
    expect(Profile.parse(p)).toEqual(p);
  });

  it('a Codex-only Mac sends no Claude usage in the old field', () => {
    const p = withUsage({}, codex, { windows: [{ label: '5h', pct: 5 }] }, 1);
    expect(p.usage).toBeUndefined();
    expect(p.usages).toHaveLength(1);
  });

  it('reads an older Mac’s single usage as Claude’s', () => {
    const old = { usage: { fiveHour: { pct: 9 }, updatedAt: 1 } };
    expect(usagesOf(old)).toEqual([{ fiveHour: { pct: 9 }, updatedAt: 1, agent: CLAUDE_AGENT }]);
    expect(usagesOf(undefined)).toEqual([]);
    // Its next update starts the list from that Claude entry.
    expect(withUsage(old, codex, { tokensPerSec: 3 }, 2).usages?.map((u) => u.agent.runtime)).toEqual(['claude', 'codex']);
  });

  it('an old client still parses current frames', () => {
    let p: Profile = { ...base };
    p = { ...p, ...withUsage(p, CLAUDE_AGENT, { plan: 'pro', fiveHour: { pct: 50, resetsAt: 9 } }, 1) };
    p = { ...p, ...withUsage(p, codex, { windows: [{ label: 'Weekly', pct: 3 }], signedIn: true }, 2) };
    const frame = JSON.parse(JSON.stringify(PeerInfo.parse({ ...p, peerId: 'abc', agents: [CLAUDE_AGENT, codex], defaultAgent: codex })));
    const seen = OldPeerInfo.parse(frame);
    expect(seen.usage).toEqual({ plan: 'pro', fiveHour: { pct: 50, resetsAt: 9 }, updatedAt: 1 });
    expect(OldProfile.parse(frame).name).toBe('kay');
  });
});
