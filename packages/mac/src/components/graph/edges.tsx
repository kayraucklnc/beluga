import { memo } from 'react';
import { BaseEdge, type Edge, EdgeLabelRenderer, type EdgeProps, getBezierPath } from '@xyflow/react';
import type { EdgeKind } from '@beluga/shared/graph-spec.js';
import { type Route, midpoint, roundedPath } from './graph-model.js';
import g from './graph.module.css';

/**
 * Lines between nodes. One quiet grey line per kind, told apart by their stroke: calls are
 * solid, async messages dashed with a moving dot, dependencies dotted, blockers in the problem
 * color. Pointing at a node, or a walkthrough step, darkens its lines and fades the rest.
 */

export type EdgeState = 'hot' | 'dim' | 'none';

export interface EdgeData extends Record<string, unknown> {
  readonly kind: EdgeKind;
  readonly label?: string;
  readonly emphasis?: boolean;
  readonly animated?: boolean;
  readonly state: EdgeState;
  /** This graph's marker ids (several graphs share a page). */
  readonly markers: string;
  readonly motion: boolean;
  /** ELK's route, while neither end has been dragged away from where it put them. */
  readonly route?: Route;
}

export type FlowEdge = Edge<EdgeData>;

const cx = (...c: Array<string | false | undefined>): string => c.filter(Boolean).join(' ');

/** The arrowheads, once per graph: plain, lit, accent and blocker. */
export function EdgeMarkers({ id }: { id: string }) {
  const marker = (name: string, className: string) => (
    <marker id={`${id}-${name}`} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
      <path d="M1 1.5L8.5 5L1 8.5z" className={className} />
    </marker>
  );
  return (
    <svg className={g.markerDefs} aria-hidden="true">
      <defs>
        {marker('plain', g.markPlain!)}
        {marker('hot', g.markHot!)}
        {marker('accent', g.markAccent!)}
        {marker('blocks', g.markBlocks!)}
      </defs>
    </svg>
  );
}

const moving = (kind: EdgeKind, animated?: boolean): boolean => animated ?? (kind === 'async' || kind === 'data');

function routed(route: Route): [string, number, number] {
  const at = route.label ?? midpoint(route.points);
  return [roundedPath(route.points), at.x, at.y];
}

export const GraphEdge = memo(function GraphEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<FlowEdge>) {
  const [path, labelX, labelY] = data?.route ? routed(data.route) : getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.32 });
  const kind = data?.kind ?? 'flow';
  const state = data?.state ?? 'none';
  const markerName = kind === 'blocks' ? 'blocks' : data?.emphasis ? 'accent' : state === 'hot' ? 'hot' : 'plain';
  const dot = data?.motion && moving(kind, data.animated) && state !== 'dim';
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={`url(#${data?.markers}-${markerName})`}
        className={cx(g.edge, g[`edge_${kind}`], data?.emphasis && g.edgeEmphasis, state === 'hot' && g.edgeHot, state === 'dim' && g.edgeDim, data?.motion && kind === 'async' && g.edgeFlowing)}
        interactionWidth={14}
      />
      {dot ? (
        <circle r={2.6} className={cx(g.edgeDot, data?.emphasis && g.edgeDotAccent)}>
          <animateMotion dur={kind === 'async' ? '2.6s' : '1.9s'} repeatCount="indefinite" path={path} />
        </circle>
      ) : null}
      {data?.label ? (
        <EdgeLabelRenderer>
          <div className={cx(g.edgeLabel, state === 'hot' && g.edgeLabelHot, state === 'dim' && g.edgeLabelDim, 'nopan')} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            {data.label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
});

export const EDGE_TYPES = { graph: GraphEdge } as const;
