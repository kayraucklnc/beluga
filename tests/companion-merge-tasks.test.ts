import { describe, expect, it, vi } from 'vitest';
import { branchStep } from '../src/companion/branch-steps.js';
import { type MergeBook, merge, mergeCheckOf, resolve } from '../src/companion/merge.js';
import { MergeCheckView, type MergeView } from '../src/companion/protocol.js';
import { COMPANION_API } from '../src/ipc/companion-api.js';
import type { Session } from '../src/core/session.js';
import type { MergePreview } from '../src/workspaces/merge-preview.js';

/** Merging a worktree from the phone (BLG-67) and describing a task (BLG-48), the Mac's own way. */

const preview: MergePreview = {
  from: 'beluga/auth',
  into: 'main',
  folder: '/Users/k/landing',
  folderOn: 'main',
  folderChanges: [],
  uncommitted: 0,
  commits: [{ hash: 'abc1234', subject: 'Protect the **payment** routes', author: 'kayra', when: 1 }],
  commitCount: 1,
  files: 3,
  insertions: 40,
  deletions: 2,
  newOnTarget: 0,
  conflicts: ['src/core/store.ts', 'packages/app/Home.tsx'],
};

function session(result: unknown, conflicts: Record<string, string[]> = {}) {
  const ask = vi.fn();
  const s = {
    store: { getState: () => ({ conflicts }) },
    workspaces: {
      manager: { find: (id: string) => (id === 'w1' ? { id, kind: 'worktree', branch: 'beluga/auth' } : id === 'main' ? { id, kind: 'main' } : undefined), mergePreview: async () => preview },
      merge: async () => result,
      askClaudeToMerge: ask,
    },
  } as unknown as Session;
  return { s, ask };
}

function book(): MergeBook & { seen: MergeView[] } {
  const m = new Map<string, MergeView>();
  const seen: MergeView[] = [];
  return { seen, get: (id) => m.get(id), set: (id, v) => (v ? (m.set(id, v), seen.push(v)) : m.delete(id), undefined) };
}

describe('merging from the phone', () => {
  it('says what the Mac’s Merge sheet says, with files by name and no folders', () => {
    const check = MergeCheckView.parse(mergeCheckOf(preview));
    expect(check).toMatchObject({ from: 'beluga/auth', into: 'main', commits: 1, files: 3, canMerge: false, conflicts: ['store.ts', 'Home.tsx'], subjects: ['Protect the payment routes'] });
    expect(check.checks.find((c) => c.id === 'conflicts')).toMatchObject({ tone: 'block', fix: 'claude', text: '2 files would conflict: store.ts, Home.tsx. Claude can merge it and resolve them.' });
    expect(JSON.stringify(check)).not.toContain('/Users/k');
    expect(mergeCheckOf({ ...preview, conflicts: [] })).toMatchObject({ canMerge: true, confirm: 'Merge 1 Commit' });
  });

  it('merges on the Mac’s path and follows it: merging, then merged or conflicts', async () => {
    const b = book();
    expect(await merge(session({ ok: true }).s, b, 'conv:ws:w1')).toMatchObject({ phase: 'merged' });
    expect(b.seen.map((v) => v.phase)).toEqual(['merging', 'merged']);
    expect(await merge(session({ ok: false, reason: 'conflict', files: ['src/a.ts'] }).s, b, 'conv:ws:w1')).toMatchObject({ phase: 'conflicts', conflicts: ['a.ts'] });
    expect(await merge(session({ ok: false, reason: 'wrong_branch', files: [], current: 'dev', expected: 'main' }).s, b, 'conv:ws:w1')).toMatchObject({ phase: 'blocked', why: expect.stringContaining('on dev, not main') });
    await expect(merge(session({ ok: true }).s, b, 'conv:ws:main')).rejects.toThrow(/worktree/);
  });

  it('asks Claude to resolve the conflicts in that worktree', () => {
    const b = book();
    const { s, ask } = session({ ok: true }, { w1: ['src/a.ts'] });
    expect(resolve(s, b, 'conv:ws:w1')).toMatchObject({ phase: 'resolving', conflicts: ['a.ts'] });
    expect(ask).toHaveBeenCalledWith('w1', ['src/a.ts']);
  });

  it('takes only a worktree’s conversation, and a draft as the phone sends it', () => {
    expect(COMPANION_API['companion.merge'].args.safeParse(['conv:ws:w1']).success).toBe(true);
    expect(COMPANION_API['companion.merge'].args.safeParse(['conv:room']).success).toBe(false);
    expect(COMPANION_API['companion.addTask'].args.safeParse([{ projectId: 'p1', title: 'Retry webhooks', goal: '', acceptance: ['Retries 3 times'], labels: [] }]).success).toBe(true);
    expect(COMPANION_API['companion.addTask'].args.safeParse([{ projectId: 'p1', title: ' ', goal: '', acceptance: [], labels: [] }]).success).toBe(false);
  });
});

describe('a branch’s steps from the phone', () => {
  const steps = () => {
    const archive = vi.fn(async () => true);
    const mergePr = vi.fn(async () => ({ ok: false, reason: 'blocked', message: 'An approving review is required' }));
    const fixChecks = vi.fn();
    const s = {
      store: { getState: () => ({ conflicts: {} }) },
      workspaces: { manager: { find: (id: string) => (id === 'w1' ? { id, name: 'auth', kind: 'worktree', branch: 'beluga/auth' } : undefined) }, archive },
      workbench: { mergePr, fixChecks },
    } as unknown as Session;
    return { s, archive, mergePr, fixChecks };
  };

  it('does them the Mac’s way and says how it went', async () => {
    const { s, archive, mergePr, fixChecks } = steps();
    expect(await branchStep(s, 'conv:ws:w1', 'archive')).toEqual({ ok: true, message: 'auth is archived: its branch and conversation are kept' });
    expect(archive).toHaveBeenCalledWith('w1');
    expect(await branchStep(s, 'conv:ws:w1', 'merge_auto')).toEqual({ ok: false, message: 'An approving review is required' });
    expect(mergePr).toHaveBeenCalledWith('w1', { method: 'squash', auto: true });
    expect(await branchStep(s, 'conv:ws:w1', 'fix_checks')).toMatchObject({ ok: true, message: expect.stringContaining('Claude') });
    expect(fixChecks).toHaveBeenCalledWith('w1');
    await expect(branchStep(s, 'conv:ws:nope', 'archive')).rejects.toThrow(/worktree/);
  });

  it('takes only the steps the phone can ask for (merging locally keeps its sheet)', () => {
    expect(COMPANION_API['companion.branchStep'].args.safeParse(['conv:ws:w1', 'continue_after_merge']).success).toBe(true);
    expect(COMPANION_API['companion.branchStep'].args.safeParse(['conv:ws:w1', 'merge']).success).toBe(false);
    expect(COMPANION_API['companion.branchStep'].args.safeParse(['conv:room', 'archive']).success).toBe(false);
  });
});
