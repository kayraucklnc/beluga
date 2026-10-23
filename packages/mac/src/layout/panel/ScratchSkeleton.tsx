import { DotMatrix } from '../../components/DotMatrix.js';
import { Icon } from '../../components/Icon.js';
import { Button, cx } from '../../components/ui.js';
import { GHOST_WIDTHS } from './scratch-model.js';
import k from './scratch.module.css';

/**
 * The Scratch tab before anything is saved: the list and the preview drawn in outline, so it's clear
 * what will land here. While Claude works they softly move and the top line says so.
 */

interface ScratchSkeletonProps {
  readonly working: boolean;
  /** The folders shown here, from the workspace's root. */
  readonly folders: readonly string[];
  /** Claude is given no scratch folder (Settings › Claude). */
  readonly off: boolean;
  /** Beluga's own folder (where Show in Finder goes). */
  readonly dir: string;
  readonly onReveal: () => void;
}

function GhostRow({ width }: { width: number }) {
  return (
    <div className={k.ghost}>
      <span className={k.icon} />
      <span className={cx(k.bar, k.name)} style={{ width: `${width}%` }} />
      <span className={cx(k.bar, k.meta)} />
    </div>
  );
}

export function ScratchSkeleton({ working, folders, off, dir, onReveal }: ScratchSkeletonProps) {
  return (
    <div className={cx(k.skeleton, working && k.live)} aria-busy={working}>
      <div className={k.status} role="status">
        {working ? (
          <>
            <DotMatrix size={13} className={k.statusWorking} />
            <span className={cx(k.statusTitle, k.statusWorking)}>Claude is working</span>
            <span>· files it saves show up here</span>
          </>
        ) : (
          <>
            <Icon name="pulse" size={13} />
            <span className={k.statusTitle}>Nothing saved yet</span>
          </>
        )}
      </div>
      <div className={k.ghosts} aria-hidden>
        {GHOST_WIDTHS.map((w) => (
          <GhostRow key={w} width={w} />
        ))}
      </div>
      <div className={k.tile} aria-hidden>
        <Icon name="image" size={22} />
      </div>
      <div className={k.foot}>
        <span>{off ? 'Claude isn’t given a scratch folder (Settings › Claude)' : folders.map((f) => `${f}/`).join('  ·  ')}</span>
        <span className={k.flex} />
        <Button icon="folder" title={dir} onClick={onReveal}>
          Show in Finder
        </Button>
      </div>
    </div>
  );
}

/** On top of the list while Claude works: where its next file will land. */
export function NextFileRow() {
  return (
    <div className={cx(k.next, k.live)} role="status">
      <DotMatrix size={12} />
      <span>Claude is working</span>
      <span className={k.bar} aria-hidden />
    </div>
  );
}
