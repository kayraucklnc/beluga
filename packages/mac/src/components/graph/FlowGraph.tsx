import '@xyflow/react/dist/base.css';
import { type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  MiniMap,
  type NodeChange,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
  useUpdateNodeInternals,
} from '@xyflow/react';
import type { Graph, GraphDirection } from '@beluga/shared/graph-spec.js';
import { IconButton } from '../ui.js';
import { reducedMotion, useDocTheme } from '../markdown/use-doc-theme.js';
import { type ElkOutput, type Focus, type Placed, type Route, type Size, elkGraph, handleSides, inlineAspect, neighborhood, parentsFirst, placesOf, routesOf, stepFocus } from './graph-model.js';
import { cachedLayout, rememberLayout } from './layout-cache.js';
import { layout } from './layout.js';
import { useSharpZoom } from './sharp-zoom.js';
import { NODE_TYPES, type FlowNode, drawingOf } from './nodes.js';
import { EDGE_TYPES, EdgeMarkers, type EdgeState, type FlowEdge } from './edges.js';
import { Inspector } from './Inspector.js';
import { Walkthrough } from './Walkthrough.js';
import g from './graph.module.css';

/**
 * A `beluga-graph`, drawn with React Flow and laid out by ELK. Nodes are drawn once out of
 * sight to learn their sizes, laid out, then shown. Point at a node to see what it touches,
 * click it for its details, step through the walkthrough Claude wrote, turn the layout, or open
 * the graph in the whole window (minimap, two-finger scroll pans, pinch zooms).
 */

export interface FlowGraphProps {
  readonly graph: Graph;
  readonly mode: 'inline' | 'full';
  readonly localImages: boolean;
  /** Open this graph in the whole window (inline only). */
  readonly onExpand?: () => void;
  readonly onCopy?: () => void;
  /** Start in the walkthrough (the full window opened from a step). */
  readonly startStep?: number;
  /** The laid-out graph's size (the card fits its height to it). */
  readonly onLaidOut?: (size: Size) => void;
  /** The block's text: a graph laid out before is shown again at once (layout-cache.ts). */
  readonly cacheKey?: string;
  /** Nodes stand for something that opens (a task): the details panel's main button, and double-click. */
  readonly onOpen?: (nodeId: string) => void;
  readonly openLabel?: string;
}

/** A fresh canvas for each graph (Claude rewrote the block, the file changed): nothing carries over. */
const graphKeys = new WeakMap<Graph, number>();
let nextKey = 0;
const keyOf = (graph: Graph): number => {
  let k = graphKeys.get(graph);
  if (k === undefined) graphKeys.set(graph, (k = ++nextKey));
  return k;
};

export default function FlowGraph(props: FlowGraphProps) {
  return (
    <ReactFlowProvider>
      <Canvas key={keyOf(props.graph)} {...props} />
    </ReactFlowProvider>
  );
}

type Phase = 'measuring' | 'laying-out' | 'ready' | 'failed';

const NO_FOCUS: Focus = { nodes: new Set(), edges: new Set() };

function baseNodes(graph: Graph, direction: GraphDirection, localImages: boolean): FlowNode[] {
  const sides = handleSides(direction);
  return parentsFirst(graph.nodes).map((node) => ({
    id: node.id,
    type: drawingOf(node),
    position: { x: 0, y: 0 },
    data: { node, sides, localImages },
    ...(node.group ? { parentId: node.group } : {}),
    ...(node.type === 'group' ? { selectable: true, draggable: false, style: { width: 200, height: 120 }, zIndex: -1 } : {}),
  }));
}

/** Nodes moved to where the layout put them (groups get their size), their handles on the right sides. */
function placeNodes(nodes: readonly FlowNode[], places: ReadonlyMap<string, Placed>, direction: GraphDirection): FlowNode[] {
  const sides = handleSides(direction);
  return nodes.map((n) => {
    const at = places.get(n.id);
    const data = { ...n.data, sides };
    if (!at) return { ...n, data };
    const box = n.data.node.type === 'group' ? { style: { ...n.style, width: at.width, height: at.height }, width: at.width, height: at.height } : {};
    return { ...n, data, position: { x: at.x, y: at.y }, ...box };
  });
}

/** Room for the walkthrough's caption along the bottom. */
const STEP_PADDING = { top: '48px', left: '48px', right: '48px', bottom: '150px' } as const;

function Canvas({ graph, mode, localImages, onExpand, onCopy, startStep, onLaidOut, cacheKey, onOpen, openLabel }: FlowGraphProps) {
  const uid = useId().replace(/[^\w-]/g, '');
  const theme = useDocTheme();
  const motion = !reducedMotion();
  const flow = useReactFlow<FlowNode, FlowEdge>();
  useSharpZoom();
  const updateInternals = useUpdateNodeInternals();
  const initialized = useNodesInitialized();
  // Laid out before (this graph scrolled out of the conversation and back): show it at once.
  const [cached] = useState(() => cachedLayout(cacheKey, mode));
  const [direction, setDirection] = useState<GraphDirection>(cached?.direction ?? graph.direction);
  const [nodes, setNodes] = useState<FlowNode[]>(() => {
    const base = baseNodes(graph, cached?.direction ?? graph.direction, localImages);
    return cached ? placeNodes(base, cached.places, cached.direction) : base;
  });
  const [phase, setPhase] = useState<Phase>(cached ? 'ready' : 'measuring');
  const [hover, setHover] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [step, setStep] = useState<number>(startStep ?? -1);
  const stepRef = useRef(step);
  stepRef.current = step;
  const sizes = useRef(new Map<string, Size>());
  // ELK's lines, and the nodes dragged since (their lines curve to wherever they are now).
  const [routes, setRoutes] = useState<ReadonlyMap<string, Route>>(cached?.routes ?? new Map());
  const [moved, setMoved] = useState<ReadonlySet<string>>(new Set());
  const run = useRef(0);
  const wrap = useRef<HTMLDivElement>(null);
  const duration = motion ? 450 : 0;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // The whole drawing, lines included (ELK's lines can reach past the nodes), framed in the canvas.
  const bounds = useRef<Size | undefined>(cached?.bounds);
  const frameAll = (ms: number): void => {
    const box = wrap.current;
    const b = bounds.current;
    if (!box || !b) return void flow.fitView({ padding: 0.1, maxZoom: 1, duration: ms });
    const pad = mode === 'inline' ? 10 : 28;
    // Hidden or tiny (being shown, a collapsed row): wait for a real size.
    if (box.clientWidth <= pad * 2 + 20 || box.clientHeight <= pad * 2 + 20) return;
    const zoom = Math.max(0.05, Math.min(1, (box.clientWidth - pad * 2) / b.width, (box.clientHeight - pad * 2) / b.height));
    void flow.setViewport({ x: (box.clientWidth - b.width * zoom) / 2, y: (box.clientHeight - b.height * zoom) / 2, zoom }, { duration: ms });
  };

  // Walkthrough: each step frames what it's about.
  const steps = graph.steps;
  const current = step >= 0 ? steps[step] : undefined;
  const frameStep = (i: number, ms: number): void => {
    const s = steps[i];
    const ids = s ? [...stepFocus(graph, s).nodes].map((id) => ({ id })) : [];
    if (ids.length) void flow.fitView({ nodes: ids, padding: STEP_PADDING, maxZoom: 1.1, duration: ms });
    else frameAll(ms);
  };
  const frame = (ms: number): void => (stepRef.current >= 0 ? frameStep(stepRef.current, ms) : frameAll(ms));

  // Shown from the cache: frame it once React Flow knows the canvas, and size the card.
  useEffect(() => {
    if (!cached) return;
    onLaidOut?.(cached.bounds);
    requestAnimationFrame(() => frame(0));
  }, []);

  const lay = useCallback(
    async (dir: GraphDirection): Promise<void> => {
      const mine = ++run.current;
      setPhase((p) => (p === 'ready' ? p : 'laying-out'));
      const box = wrap.current;
      const aspect = box && box.clientHeight ? (mode === 'inline' ? inlineAspect(box.clientWidth) : box.clientWidth / box.clientHeight) : undefined;
      let out: ElkOutput | undefined;
      // Wrapping a long chain is a nicety: if it fails (or takes too long), lay it out plainly.
      for (const shape of aspect ? [aspect, undefined] : [undefined]) {
        try {
          out = await layout(elkGraph(graph, sizes.current, dir, shape));
          break;
        } catch {
          if (mine !== run.current) return;
        }
      }
      if (mine !== run.current) return;
      if (!out) return setPhase('failed');
      const places = placesOf(out);
      const lines = routesOf(out);
      setRoutes(lines);
      setMoved(new Set());
      if (out.width && out.height) {
        bounds.current = { width: out.width, height: out.height };
        onLaidOut?.(bounds.current);
        rememberLayout(cacheKey, mode, { direction: dir, places, routes: lines, bounds: bounds.current });
      }
      setNodes((now) => placeNodes(now, places, dir));
      // The handles moved sides: React Flow measures them again before drawing lines.
      requestAnimationFrame(() => {
        if (mine !== run.current) return;
        updateInternals(graph.nodes.map((n) => n.id));
        requestAnimationFrame(() => {
          if (mine !== run.current) return;
          frame(phaseRef.current === 'ready' ? duration : 0);
          setPhase('ready');
        });
      });
    },
    [graph, mode, duration, cacheKey],
  );

  // Every node has been measured once: lay out with the real sizes.
  useEffect(() => {
    if (!initialized || phase !== 'measuring') return;
    for (const n of flow.getNodes()) {
      if (n.data.node.type === 'group') continue;
      const w = n.measured?.width;
      const h = n.measured?.height;
      if (w && h) sizes.current.set(n.id, { width: Math.ceil(w), height: Math.ceil(h) });
    }
    void lay(direction);
  }, [initialized, phase]);

  // The frame changed size (the card fit its height, the window was resized): frame the graph again.
  useEffect(() => {
    const box = wrap.current;
    if (!box) return;
    let last = '';
    const observer = new ResizeObserver(() => {
      const size = `${box.clientWidth}x${box.clientHeight}`;
      if (size === last) return;
      const first = !last;
      last = size;
      if (!first && phaseRef.current !== 'measuring' && stepRef.current < 0) frameAll(0);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [mode]);

  const turn = (): void => {
    const next: GraphDirection = direction === 'right' || direction === 'left' ? 'down' : 'right';
    setDirection(next);
    // Sizes from the cache aren't known: measure first (the canvas stays as it is meanwhile).
    if (!sizes.current.size) {
      for (const n of flow.getNodes()) {
        const w = n.measured?.width;
        const h = n.measured?.height;
        if (n.data.node.type !== 'group' && w && h) sizes.current.set(n.id, { width: Math.ceil(w), height: Math.ceil(h) });
      }
    }
    void lay(next);
  };

  useEffect(() => {
    if (phase === 'ready' && step >= 0) frameStep(step, duration);
  }, [step, phase]);
  const goStep = (i: number): void => {
    setSelected(undefined);
    if (i < 0 || i >= steps.length) {
      setStep(-1);
      frameAll(duration);
      return;
    }
    setStep(i);
  };

  // What's lit: the step, else what you point at, else what you picked. (Kept while nothing changes,
  // so dragging doesn't redraw every line.)
  const focus = useMemo<Focus>(() => (current ? stepFocus(graph, current) : hover ? neighborhood(graph, hover) : selected ? neighborhood(graph, selected) : NO_FOCUS), [graph, current, hover, selected]);
  const lit = focus.nodes.size > 0;

  const shown = useMemo(
    () =>
      nodes.map((n) => {
        const state = !lit ? '' : focus.nodes.has(n.id) ? g.nodeHot : n.data.node.type === 'group' ? '' : g.nodeDim;
        return { ...n, className: state, selected: n.id === selected };
      }),
    [nodes, focus, lit, selected],
  );
  const edges = useMemo<FlowEdge[]>(
    () =>
      graph.edges.map((e) => {
        const state: EdgeState = !lit ? 'none' : focus.edges.has(e.id) ? 'hot' : 'dim';
        return {
          id: e.id,
          source: e.from,
          target: e.to,
          type: 'graph',
          data: { kind: e.kind, state, markers: uid, motion, ...(routes.has(e.id) && !moved.has(e.from) && !moved.has(e.to) ? { route: routes.get(e.id)! } : {}), ...(e.label ? { label: e.label } : {}), ...(e.emphasis ? { emphasis: true } : {}), ...(e.animated !== undefined ? { animated: e.animated } : {}) },
        };
      }),
    [graph, focus, lit, uid, motion, routes, moved],
  );

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    // Selection is this graph's own (one node at a time); the rest (sizes, drags) is React Flow's.
    setNodes((now) => applyNodeChanges(changes.filter((c) => c.type !== 'select'), now));
  }, []);

  const focusNode = (id: string): void => {
    setSelected(id);
    const n = flow.getInternalNode(id);
    if (!n) return;
    const w = n.measured.width ?? 0;
    const h = n.measured.height ?? 0;
    void flow.setCenter(n.internals.positionAbsolute.x + w / 2, n.internals.positionAbsolute.y + h / 2, { zoom: Math.max(flow.getZoom(), 0.9), duration });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && (step >= 0 || selected)) {
      e.stopPropagation();
      if (selected) setSelected(undefined);
      else goStep(-1);
      return;
    }
    if (step < 0) return;
    if (e.key === 'ArrowRight') (e.preventDefault(), goStep(Math.min(steps.length - 1, step + 1)));
    if (e.key === 'ArrowLeft') (e.preventDefault(), goStep(Math.max(0, step - 1)));
  };

  const picked = selected ? graph.nodes.find((n) => n.id === selected) : undefined;
  const inline = mode === 'inline';
  const across = direction === 'right' || direction === 'left';

  return (
    <div ref={wrap} className={g.canvas} data-mode={mode} data-phase={phase} data-ready={phase === 'ready' ? 'true' : 'false'} onKeyDown={onKeyDown} tabIndex={-1}>
      <EdgeMarkers id={uid} />
      <ReactFlow<FlowNode, FlowEdge>
        nodes={shown}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStart={(_e, n) => setMoved((m) => new Set([...m, n.id, ...graph.nodes.filter((x) => x.group === n.id).map((x) => x.id)]))}
        onNodeClick={(_e, n) => setSelected((s) => (s === n.id ? undefined : n.id))}
        {...(onOpen ? { onNodeDoubleClick: (_e: unknown, n: FlowNode) => onOpen(n.id) } : {})}
        onNodeMouseEnter={(_e, n) => setHover(n.data.node.type === 'group' ? undefined : n.id)}
        onNodeMouseLeave={() => setHover(undefined)}
        onPaneClick={() => setSelected(undefined)}
        colorMode={theme}
        minZoom={0.15}
        maxZoom={2.5}
        nodesConnectable={false}
        nodesDraggable
        elementsSelectable
        selectNodesOnDrag={false}
        zoomOnDoubleClick={false}
        // In a conversation, scrolling scrolls the conversation; pinch zooms and dragging pans.
        zoomOnScroll={false}
        panOnScroll={!inline}
        preventScrolling={!inline}
        zoomOnPinch
        panOnDrag
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} className={g.dots} />
        {!inline ? <MiniMap pannable zoomable className={g.minimap} nodeClassName={(n) => (n.type === 'group' ? g.miniGroup! : g.miniNode!)} /> : null}
        <Panel position="top-right" className={g.tools}>
          {steps.length ? <IconButton icon="play" label={step >= 0 ? 'Leave the Walkthrough' : 'Walk Me Through It'} active={step >= 0} onClick={() => goStep(step >= 0 ? -1 : 0)} /> : null}
          <IconButton icon={across ? 'chevronDown' : 'chevronRight'} label={across ? 'Lay Out Top to Bottom' : 'Lay Out Left to Right'} onClick={turn} />
          <IconButton icon="outline" label="Fit to View" onClick={() => frameAll(duration)} />
          {onCopy ? <IconButton icon="copy" label="Copy as JSON" onClick={onCopy} /> : null}
          {onExpand ? <IconButton icon="expand" label="Open in Full Window" onClick={onExpand} /> : null}
        </Panel>
        {!inline ? (
          <Panel position="bottom-left" className={g.zoom}>
            <IconButton icon="minus" label="Zoom Out" onClick={() => void flow.zoomOut({ duration })} />
            <IconButton icon="plus" label="Zoom In" onClick={() => void flow.zoomIn({ duration })} />
          </Panel>
        ) : null}
      </ReactFlow>
      {phase === 'failed' ? <div className={g.overlayNote}>Couldn’t lay this graph out.</div> : phase !== 'ready' ? <div className={g.overlayNote}>Laying out…</div> : null}
      {current ? <Walkthrough steps={steps} index={step} onGo={goStep} /> : null}
      {picked ? <Inspector graph={graph} node={picked} onPick={focusNode} onClose={() => setSelected(undefined)} wide={!inline} {...(onOpen ? { onOpen: () => onOpen(picked.id), openLabel: openLabel ?? 'Open' } : {})} /> : null}
    </div>
  );
}
