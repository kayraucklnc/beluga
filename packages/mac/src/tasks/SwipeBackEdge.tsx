import type { CSSProperties } from 'react';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import t from './tasks.module.css';

/**
 * The arrow that comes in from the left edge while you swipe back (as Chrome's): it follows the
 * swipe, and fills in once letting go would go back. Nothing while there's no swipe.
 */
export function SwipeBackEdge({ progress }: { progress: number }) {
  if (progress <= 0) return null;
  const armed = progress >= 1;
  return (
    <div className={cx(t.swipeEdge, armed && t.swipeArmed)} style={{ '--swipe': progress } as CSSProperties} aria-hidden="true">
      <Icon name="back" size={16} />
    </div>
  );
}
