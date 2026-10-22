import { describe, expect, it } from 'vitest';
import type { Plan, PlansState } from '../src/core/plans/model.js';
import { isPlanHome } from '../src/core/plans/model.js';
import { CHAT_DEFAULT, CHAT_MIN, DEFAULT_PLAN_LAYOUT, chatOpen, clampChatWidth, readPlanLayout, setChatOpen } from '../packages/mac/src/plans/plan-layout.js';

describe('plan page layout', () => {
  it('reads older and broken saves as the defaults', () => {
    expect(readPlanLayout(undefined)).toEqual(DEFAULT_PLAN_LAYOUT);
    expect(readPlanLayout({ display: 'outline', chat: false })).toEqual({ ...DEFAULT_PLAN_LAYOUT, display: 'outline' });
    expect(readPlanLayout({ closed: ['a', 3, 'b'], chatWidth: 'wide' })).toEqual({ ...DEFAULT_PLAN_LAYOUT, closed: ['a', 'b'] });
    expect(readPlanLayout({ chatWidth: 120 }).chatWidth).toBe(CHAT_MIN);
  });

  it('remembers each plan’s chat on its own', () => {
    const one = setChatOpen(DEFAULT_PLAN_LAYOUT, 'p1', false);
    expect(chatOpen(one, 'p1')).toBe(false);
    expect(chatOpen(one, 'p2')).toBe(true);
    expect(setChatOpen(one, 'p1', false).closed).toEqual(['p1']);
    expect(chatOpen(setChatOpen(one, 'p1', true), 'p1')).toBe(true);
  });

  it('keeps the chat between its minimum and half the plan’s width', () => {
    expect(clampChatWidth(CHAT_DEFAULT, 1400)).toBe(CHAT_DEFAULT);
    expect(clampChatWidth(100, 1400)).toBe(CHAT_MIN);
    expect(clampChatWidth(1000, 1400)).toBe(700);
    // A narrow window: never below the minimum.
    expect(clampChatWidth(500, 400)).toBe(CHAT_MIN);
    expect(clampChatWidth(Number.NaN, 1400)).toBe(CHAT_DEFAULT);
  });
});

describe('a plan’s own conversation', () => {
  const plans = (...list: Array<Pick<Plan, 'home' | 'status'>>): PlansState => ({ enabled: true, style: '', plans: list as unknown as Plan[] });
  it('is a live plan’s home, not a finished one’s', () => {
    expect(isPlanHome(plans({ home: 'ws:a', status: 'draft' }), 'ws:a')).toBe(true);
    expect(isPlanHome(plans({ home: 'ws:a', status: 'active' }), 'ws:a')).toBe(true);
    expect(isPlanHome(plans({ home: 'ws:a', status: 'done' }), 'ws:a')).toBe(false);
    expect(isPlanHome(plans({ home: 'ws:a', status: 'active' }), 'ws:b')).toBe(false);
  });
});
