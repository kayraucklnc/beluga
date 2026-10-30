import { describe, expect, it } from 'vitest';
import { usageFor, withUsage } from '../src/agent/usage.js';
import { CODEX_USAGE_AGENT, fromRateLimits } from '../src/agent/runtime/codex/rate-limits.js';
import { providerCards } from '../src/ui/usage-cards.js';

/** A real `token_count` event's rate_limits from a signed-in Codex (Plus) session log. */
const ROLLOUT = { limit_id: 'codex', limit_name: null, primary: { used_percent: 11.0, window_minutes: 300, resets_at: 1780409235 }, secondary: { used_percent: 5.0, window_minutes: 10080, resets_at: 1780862132 }, credits: null, plan_type: 'plus' };

describe('Codex quota windows (BLG-460)', () => {
  it('reads a signed-in Codex’s 5-hour and weekly windows', () => {
    expect(fromRateLimits(ROLLOUT)).toEqual({ fiveHour: { pct: 11, resetsAt: 1780409235000 }, week: { pct: 5, resetsAt: 1780862132000 }, plan: 'plus' });
  });

  it('reads the app-server’s camelCase, and names windows Claude doesn’t have', () => {
    const u = fromRateLimits({ primary: { usedPercent: 0.5, windowDurationMins: 1440, resetsAt: 1780000000 }, secondary: { usedPercent: 140, windowDurationMins: 43200 }, planType: 'pro' });
    expect(u).toEqual({ windows: [{ label: 'Daily', pct: 1, resetsAt: 1780000000000 }, { label: 'Monthly', pct: 100 }], plan: 'pro' });
    expect(fromRateLimits({ primary: { usedPercent: 3, windowDurationMins: 180 } })?.windows?.[0]?.label).toBe('3-hour');
  });

  it('says nothing for an API-key login or an empty answer', () => {
    expect(fromRateLimits(undefined)).toBeUndefined();
    expect(fromRateLimits({ primary: null, secondary: null, planType: null })).toBeUndefined();
    expect(fromRateLimits({ primary: { usedPercent: null } })).toBeUndefined();
  });

  it('lands on the Codex card as quota windows', () => {
    const p = withUsage({}, CODEX_USAGE_AGENT, fromRateLimits(ROLLOUT)!, 1);
    expect(usageFor(p, 'codex')?.plan).toBe('plus');
    expect(p.usage).toBeUndefined();
    const card = providerCards(p, undefined).find((c) => c.key === 'codex');
    expect(card?.shape).toBe('quota');
    expect(card?.windows.map((w) => `${w.label} ${w.pct}%`)).toEqual(['5-hour 11%', 'Weekly 5%']);
  });
});
