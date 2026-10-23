import { afterEach, describe, expect, it, vi } from 'vitest';
import { reducedMotion } from '../packages/mac/src/lib/reduced-motion.js';
import type { BoardState } from '../src/core/board/model.js';
import type { Plan, PlansState } from '../src/core/plans/model.js';
import { planOfPlace } from '../src/core/plans/owner.js';
import { messageState } from '../src/core/plans/watchdog.js';
import { READS_AFTER_STEP } from '../src/shared/claude-notices.js';
import { progressCount } from '../src/shared/progress-count.js';
import { resultText } from '../src/shared/steps.js';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { conflictedFiles, git, tryGit } from '../src/workspaces/git.js';

// KLD-58: helpers PR #66 wrote twice, now one; these pin the behaviour each copy had.
describe('polish-round leftovers', () => {
  it("a steered message in the running turn reads as in_turn, with AgentHost's own words (one constant)", () => {
    expect(messageState({ status: 'started', text: READS_AFTER_STEP })).toBe('in_turn');
    expect(messageState({ status: 'started', text: 'Done.' })).toBe('read');
  });

  it("a plan's home conversation is the plan's place: the newest plan wins (planForHome)", () => {
    const plan = (id: string): Plan => ({ id, home: 'ws:chat1' }) as unknown as Plan;
    const plans = { enabled: true, plans: [plan('old'), plan('new')], style: '' } as PlansState;
    const board = { enabled: true, issues: [], projects: {}, autoTasks: false } as unknown as BoardState;
    expect(planOfPlace(plans, board, { kind: 'workspace', id: 'chat1' })).toBe('new');
    expect(planOfPlace(plans, board, { kind: 'plan', id: 'p9' })).toBe('p9');
  });

  describe('reducedMotion (one check for live marks, chat flights and documents)', () => {
    afterEach(() => vi.unstubAllGlobals());
    const stub = (motion: string | undefined, system: boolean | undefined) => {
      vi.stubGlobal('document', { documentElement: { dataset: motion ? { motion } : {} } });
      vi.stubGlobal('window', system === undefined ? {} : { matchMedia: () => ({ matches: system }) });
    };
    it('Settings › Appearance or the system asks for less motion', () => {
      stub('reduce', false);
      expect(reducedMotion()).toBe(true);
      stub(undefined, true);
      expect(reducedMotion()).toBe(true);
      stub(undefined, false);
      expect(reducedMotion()).toBe(false);
    });
    it('a window without matchMedia moves', () => {
      stub(undefined, undefined);
      expect(reducedMotion()).toBe(false);
    });
  });

  it('conflictedFiles: the files a merge left conflicted (one helper for merges, combines and stash applies)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kld58-'));
    const commit = async (body: string, msg: string) => {
      writeFileSync(path.join(dir, 'a.txt'), body);
      await git(dir, ['add', '.']);
      await git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg]);
    };
    await git(dir, ['init', '-q', '-b', 'main']);
    await commit('base\n', 'base');
    expect(await conflictedFiles(dir)).toEqual([]);
    await git(dir, ['checkout', '-qb', 'other']);
    await commit('theirs\n', 'theirs');
    await git(dir, ['checkout', '-q', 'main']);
    await commit('ours\n', 'ours');
    expect(await tryGit(dir, ['merge', '--no-edit', 'other'])).toBeUndefined();
    expect(await conflictedFiles(dir)).toEqual(['a.txt']);
  });

  it("resultText reads a tool result for the runner's progress count too (a string or text blocks)", () => {
    expect(resultText('12/40 passed')).toBe('12/40 passed');
    expect(resultText([{ type: 'text', text: 'Running 40 tests' }, { type: 'image' }, { type: 'text', text: '12/40 passed' }])).toBe('Running 40 tests\n[image]\n12/40 passed');
    expect(resultText(undefined)).toBe('');
    expect(progressCount(resultText([{ type: 'text', text: '[12/40] tests' }]))).toBeDefined();
  });

  it("the Mac UI's ticking clocks are known: new ones use lib/window-active useClock (it rests while you look away, KLD-40)", () => {
    const root = path.join(import.meta.dirname, '../packages/mac/src');
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f));
    const ticking = files.filter((f) => readFileSync(path.join(root, f), 'utf8').includes('setInterval(')).map((f) => f.split(path.sep).join('/')).sort();
    // The PR sheet's own once-a-second clock ticked behind your back; it uses useClock now. Shrink this list, don't grow it.
    expect(ticking).toEqual([
      'chat/steps/use-steps.ts',
      'claude-code/AgentOutputs.tsx',
      'claude-code/BackgroundTasks.tsx',
      'layout/NotificationCenter.tsx',
      'layout/panel/ScratchTab.tsx',
      'lib/live-motion.ts',
      'lib/window-active.ts',
      'network/AddFriendSheet.tsx',
      'network/ConversationView.tsx',
      'network/net-native.ts',
      'plans/use-plans.ts',
      'views/project/MainSyncBar.tsx',
      'views/room/ConnectionStatus.tsx',
    ]);
  });
});
