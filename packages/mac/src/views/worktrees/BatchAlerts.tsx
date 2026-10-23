import { formatBytes } from '@beluga/shared/format.js';
import { Alert } from '../../components/Alert.js';
import type { WorktreeRow } from './worktrees-model.js';

/**
 * Before archiving, removing build files from or deleting several worktrees at once: what
 * happens to them, and what it frees or loses. Archiving keeps everything of yours; removing
 * build files keeps the worktrees and clears only what's made again; deleting is for good.
 */

export type Batch = 'archive' | 'free' | 'delete';

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
        title={`Remove build files from ${plural(n, 'worktree')}?`}
        message={
          <>
            <p>Deletes what the project makes again by itself: node_modules, build output and caches ({freed}).</p>
            <p>Your work stays: files, commits, uncommitted changes, ignored files like .env, and the worktrees themselves. To work in one again, run its setup (npm install and the like).</p>
          </>
        }
        confirm={{ label: 'Remove Build Files', onClick: onConfirm }}
        onCancel={onCancel}
      />
    );
  }
  if (batch === 'delete') {
    const branches = rows.filter((r) => r.madeBy.kind === 'beluga' && r.ws.branch).length;
    const saved = rows.filter((r) => r.ws.archive).length;
    return (
      <Alert
        icon="alert"
        tone="danger"
        title={`Delete ${plural(n, 'archived worktree')} permanently?`}
        message={
          <>
            <p>
              {saved ? `${saved === n ? 'Their archives' : plural(saved, 'archive')} (uncommitted work and files of yours kept when archived) ` : ''}
              {saved && branches ? 'and ' : ''}
              {branches ? `${branches === 1 ? 'the branch' : `${branches} branches`} Beluga made (commits only there) ` : ''}
              {saved || branches ? 'go, with their conversations.' : 'Their conversations go.'} Branches other tools made are kept.
            </p>
            <p>You can’t undo this.</p>
          </>
        }
        confirm={{ label: `Delete ${plural(n, 'Worktree')}`, destructive: true, onClick: onConfirm }}
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
          <p>Everything of yours in them is kept: uncommitted work, new files and ignored files like .env. Their build files are removed ({freed}), and the folders go.</p>
          <p>Their branches and conversations stay. Restore any of them from Archived on this page, as it was.</p>
          {outside ? <p>{outside === 1 ? 'One was' : `${outside} were`} made outside Beluga: the app that made {outside === 1 ? 'it' : 'them'} may still have {outside === 1 ? 'it' : 'them'} open.</p> : null}
        </>
      }
      confirm={{ label: `Archive ${plural(n, 'Worktree')}`, onClick: onConfirm }}
      onCancel={onCancel}
    />
  );
}
