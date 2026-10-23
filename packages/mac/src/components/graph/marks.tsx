import type { GraphNode, GraphStatus, NodeKind } from '@beluga/shared/graph-spec.js';
import { KIND_ICON, STATUS_INFO } from './graph-model.js';
import g from './graph.module.css';

/** A kind's icon and a status pill: small marks shared by nodes, the details panel and the card (no React Flow here). */

const cx = (...c: Array<string | false | undefined>): string => c.filter(Boolean).join(' ');

export function KindIcon({ kind, size = 16 }: { kind: NodeKind; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={KIND_ICON[kind]} />
    </svg>
  );
}

/** The card's own mark: three parts and the lines between them. */
export function GraphGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.75" y="2" width="4.5" height="4.5" rx="1.25" />
      <rect x="9.75" y="9.5" width="4.5" height="4.5" rx="1.25" />
      <path d="M6.25 4.25h2.5a1.5 1.5 0 0 1 1.5 1.5v3.75 M4 6.5v4.25a1.5 1.5 0 0 0 1.5 1.5h4.25" />
    </svg>
  );
}

/** Each status has a shape of its own, so it reads without its color. */
function StatusMark({ status }: { status: GraphStatus }) {
  const ring = <circle cx="6" cy="6" r="4.75" />;
  const shape = (() => {
    switch (status) {
      case 'todo':
        return ring;
      case 'idle':
        return <circle cx="6" cy="6" r="4.75" strokeDasharray="2 2" />;
      case 'active':
        return (
          <>
            {ring}
            <path d="M6 1.25a4.75 4.75 0 0 1 0 9.5z" fill="currentColor" stroke="none" />
          </>
        );
      case 'review':
        return (
          <>
            {ring}
            <circle cx="6" cy="6" r="1.75" fill="currentColor" stroke="none" />
          </>
        );
      case 'done':
        return (
          <>
            <circle cx="6" cy="6" r="5.5" fill="currentColor" stroke="none" />
            <path d="M3.7 6.1l1.6 1.6 3-3.2" stroke="var(--graph-card, #fff)" strokeWidth={1.4} />
          </>
        );
      case 'blocked':
        return (
          <>
            <circle cx="6" cy="6" r="5.5" fill="currentColor" stroke="none" />
            <path d="M3.75 6h4.5" stroke="var(--graph-card, #fff)" strokeWidth={1.5} />
          </>
        );
      case 'failed':
        return (
          <>
            <circle cx="6" cy="6" r="5.5" fill="currentColor" stroke="none" />
            <path d="M4.3 4.3l3.4 3.4 M7.7 4.3L4.3 7.7" stroke="var(--graph-card, #fff)" strokeWidth={1.4} />
          </>
        );
    }
  })();
  return (
    <svg className={g.statusMark} width={12} height={12} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {shape}
    </svg>
  );
}

export function StatusPill({ status }: { status: NonNullable<GraphNode['status']> }) {
  const info = STATUS_INFO[status];
  return (
    <span className={cx(g.status, g[`tone_${info.tone}`])} data-status={status}>
      <StatusMark status={status} />
      {info.label}
    </span>
  );
}
