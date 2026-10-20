import { formatBytes } from '@klaud/shared/format.js';
import { Alert } from '../../components/Alert.js';
import type { WorktreeRow } from './worktrees-model.js';

/**
 * Before archiving or cleaning several worktrees at once: what happens to them, and what it
 * frees. Archiving keeps everything of yours; cleaning keeps the worktrees and clears only what's
 * made again.
 */

export type Batch = 'archive' | 'free';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function BatchAlert({ batch, rows, rebuildable, onConfirm, onCancel }: { batch: Batch; rows: readonly WorktreeRow[]; rebuildable: number; onConfirm: () => void; onCancel: () => void }) {
  const n = rows.length;
  const freed = rebuildable ? `about ${formatBytes(rebuildable)}` : 'their space';
  const outside = rows.filter((r) => r.madeBy.kind === 'outside').length;
  if (batch === 'free') {
    return (
      <Alert
        icon="archive"
        tone="info"
        title={`Free up space in ${plural(n, 'worktree')}?`}
        message={
          <>
            <p>Their dependencies, builds and caches are cleared ({freed}). Your files, changes and ignored files like .env stay, and so do the worktrees.</p>
            <p>To work in one again, run its setup (npm install and the like).</p>
          </>
        }
        confirm={{ label: 'Free Up Space', onClick: onConfirm }}
        onCancel={onCancel}
      />
    );
  }
  return (
    <Alert
      icon="archive"
      tone="info"
      title={`Archive ${plural(n, 'worktree')}?`}
      message={
        <>
          <p>Everything of yours in them is kept: uncommitted work, new files and ignored files like .env. Their dependencies, builds and caches are cleared ({freed}), and the folders go.</p>
          <p>Their branches and conversations stay. Restore any of them from Overview › Archived, as it was.</p>
          {outside ? <p>{outside === 1 ? 'One was' : `${outside} were`} made outside Klaud: the app that made {outside === 1 ? 'it' : 'them'} may still have {outside === 1 ? 'it' : 'them'} open.</p> : null}
        </>
      }
      confirm={{ label: `Archive ${plural(n, 'Worktree')}`, onClick: onConfirm }}
      onCancel={onCancel}
    />
  );
}
