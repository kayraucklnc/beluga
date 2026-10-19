import type { GraphNode, NodeKind } from '@klaud/shared/graph-spec.js';
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

export function StatusPill({ status }: { status: NonNullable<GraphNode['status']> }) {
  const info = STATUS_INFO[status];
  return (
    <span className={cx(g.status, g[`tone_${info.tone}`])} data-status={status}>
      <span className={g.statusMark} aria-hidden="true" />
      {info.label}
    </span>
  );
}

