import { describe, expect, it } from 'vitest';
import { reviewMerge } from '../packages/mac/src/lib/merge-review.js';
import type { MergePreview } from '../src/workspaces/merge-preview.js';

const ready: MergePreview = { from: 'klaud/auth', into: 'main', folder: '/p', folderOn: 'main', folderChanges: [], uncommitted: 0, commits: [], commitCount: 2, files: 3, insertions: 10, deletions: 1, newOnTarget: 0, conflicts: [] };

describe('the merge checks', () => {
  it('lets a clean merge go, naming how many commits', () => {
    const r = reviewMerge(ready);
    expect(r.canMerge).toBe(true);
    expect(r.confirm).toBe('Merge 2 Commits');
    expect(r.checks.map((c) => [c.id, c.tone])).toEqual([
      ['conflicts', 'ok'],
      ['folder', 'ok'],
    ]);
    expect(reviewMerge({ ...ready, commitCount: 1 }).confirm).toBe('Merge 1 Commit');
  });

  it('stops for uncommitted work here, a busy main folder, the wrong branch, conflicts or nothing to merge', () => {
    const blocked = (p: Partial<MergePreview>) => {
      const r = reviewMerge({ ...ready, ...p });
      expect(r.canMerge).toBe(false);
      expect(r.confirm).toBe('Merge');
      return r.checks.filter((c) => c.tone === 'block');
    };
    expect(blocked({ uncommitted: 2 })[0]).toMatchObject({ id: 'uncommitted', fix: 'commit' });
    expect(blocked({ folderChanges: ['a', 'b', 'c', 'd'] })[0]!.text).toContain('a, b, c and 1 more');
    expect(blocked({ folderOn: 'experiment' })[0]!.text).toContain('on experiment, not main');
    expect(blocked({ conflicts: ['x.ts'] })[0]).toMatchObject({ id: 'conflicts', fix: 'claude' });
    expect(blocked({ commitCount: 0 })[0]!.id).toBe('nothing');
  });

  it('says when main has moved on, without stopping the merge', () => {
    const r = reviewMerge({ ...ready, newOnTarget: 3 });
    expect(r.canMerge).toBe(true);
    expect(r.checks.find((c) => c.id === 'newer')).toMatchObject({ tone: 'info' });
  });

  it('leaves out the conflict check when git can’t tell', () => {
    const { conflicts: _, ...unknown } = ready;
    expect(reviewMerge(unknown).checks.some((c) => c.id === 'conflicts')).toBe(false);
  });
});
