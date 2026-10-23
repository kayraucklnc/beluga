import '@xyflow/react/dist/base.css';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, BaseEdge, type Edge, type EdgeProps, Handle, type Node, type NodeProps, Panel, Position, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { AUTONOMY_INFO } from '@beluga/core/plans/model.js';
import type { MilestoneView, PlanView, TaskView } from '@beluga/core/plans/progress.js';
import { IconButton, cx } from '../components/ui.js';
import { Icon } from '../components/Icon.js';
import { useDocTheme } from '../components/markdown/use-doc-theme.js';
import { type ElkInput, type Placed, type Point, type Route, placesOf, roundedPath, routesOf } from '../components/graph/graph-model.js';
import { layout } from '../components/graph/layout.js';
import { useSharpZoom } from '../components/graph/sharp-zoom.js';
import { breath, turn, useLive } from '../lib/live-motion.js';
import { MILESTONE_STATE, TASK_STATE, changeMarks, gateId, graphShape, groupId, taskNodeId, taskWords } from './plans-model.js';
import { useClock } from './use-plans.js';
import { TaskChatMark, TaskStateIcon } from './marks.js';
import p from './plans.module.css';
import c from './PlanCanvas.module.css';

/**
 * A plan as a living graph: each milestone a box, its tasks inside laid out by what waits on what,
 * and its criteria (the gate) at its end. Milestones that run side by side sit side by side in a row;
 * a thin line runs from each one's criteria to the ones that wait on it. Tasks Claude is working on glow and
 * say what it's doing; finished ones tick; a gate waiting for you is the one thing in the accent.
 * The layout (ELK) depends only on the plan's shape, so work moving on never moves anything.
 */

/** A task card: its head, a title of up to two lines (then an ellipsis) and its state line (.task in plans.module.css). */
const TASK = { width: 252, height: 100 };
const HEAD = 62;
/** The criteria node at a milestone's end: its head, then one row per criterion (up to two lines each). */
const CRITERIA = { width: 264, head: 38, line: 15.5, row: 7, foot: 12, chars: 36 };
/** Room between milestones side by side, and between rows of them (their lines run there). */
const SIDE_GAP = 48;
const ROW_GAP = 64;
/** Where a line comes into a milestone: above its number. */
const IN_AT = 27;
/** Empty room left around the plan when it's framed: above it the view switch sits over the canvas. */
const MARGIN = { top: 48, side: 24 };
/** Opened, the plan is framed whole when it reads at this zoom; smaller, its current milestones are. */
const READABLE = 0.55;

/** How tall a criteria node is: from its criteria's words (the shape), never from their state. */
function criteriaHeight(criteria: readonly string[]): number {
  if (!criteria.length) return CRITERIA.head + CRITERIA.foot + CRITERIA.line;
  const lines = criteria.reduce((n, c) => n + Math.min(2, Math.max(1, Math.ceil(c.length / CRITERIA.chars))), 0);
  return Math.round(CRITERIA.head + lines * CRITERIA.line + (criteria.length - 1) * CRITERIA.row + CRITERIA.foot);
}

interface TaskData extends Record<string, unknown> {
  readonly view: TaskView;
  readonly key?: string;
  readonly mark?: 'added' | 'changed';
  readonly canStart: boolean;
  readonly onStart: (taskId: string) => void;
  readonly selected: boolean;
  /** In another milestone, waiting on or waited on by the task you picked. */
  readonly linked: boolean;
}
interface MilestoneData extends Record<string, unknown> {
  readonly view: MilestoneView;
  readonly current: boolean;
}
interface GateData extends Record<string, unknown> {
  readonly view: MilestoneView;
  readonly current: boolean;
  readonly selected: boolean;
}
type PlanNode = Node<TaskData, 'task'> | Node<MilestoneData, 'milestone'> | Node<GateData, 'gate'>;

interface LineData extends Record<string, unknown> {
  readonly kind: 'blocks' | 'finish' | 'next';
  readonly state: 'done' | 'live' | 'waiting';
  /** On the current path: in or into a milestone being worked on. */
  readonly current: boolean;
  readonly route?: Route;
}
type PlanEdge = Edge<LineData, 'line'>;

export interface PlanCanvasProps {
  readonly view: PlanView;
  readonly keys: ReadonlyMap<string, string>;
  readonly selected?: string;
  readonly onSelect: (id: string | undefined) => void;
  readonly onStart: (taskId: string) => void;
  readonly startable: ReadonlySet<string>;
}

export default function PlanCanvas(props: PlanCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

interface Laid {
  readonly key: string;
  readonly places: ReadonlyMap<string, Placed>;
  readonly routes: ReadonlyMap<string, Route>;
}

/** ELK's options for a milestone's inside: its tasks left to right by what waits on what, its criteria last. */
const INSIDE = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.layered.spacing.nodeNodeBetweenLayers': '56',
  'elk.spacing.nodeNode': '16',
  'elk.layered.spacing.edgeNodeBetweenLayers': '20',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.spacing.edgeEdge': '10',
  // The lines into the criteria meet before it, as one.
  'elk.layered.mergeEdges': 'true',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  // What can start at once lines up on the left; the criteria are always last.
  'elk.layered.layering.strategy': 'LONGEST_PATH_SOURCE',
  'elk.padding': `[top=${HEAD + 12},left=20,bottom=20,right=20]`,
} as const;

/** …and for the plan: milestones top to bottom by what waits on what, side by side when they run at once. */
const PLAN = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.layered.layering.strategy': 'LONGEST_PATH_SOURCE',
  'elk.spacing.nodeNode': String(SIDE_GAP),
  'elk.layered.spacing.nodeNodeBetweenLayers': String(ROW_GAP),
  'elk.layered.spacing.edgeNodeBetweenLayers': '24',
  'elk.spacing.edgeEdge': '14',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '14',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
  'elk.padding': '[top=24,left=24,bottom=24,right=24]',
} as const;

function Canvas({ view, keys, selected, onSelect, onStart, startable }: PlanCanvasProps) {
  const theme = useDocTheme();
  const flow = useReactFlow<PlanNode, PlanEdge>();
  useSharpZoom();
  const shape = useMemo(() => graphShape(view.plan), [view.plan]);
  const [laid, setLaid] = useState<Laid>();
  const [failed, setFailed] = useState(false);
  const framed = useRef(false);
  const marks = useMemo(() => changeMarks(view.plan), [view.plan]);

  // Lay out when the shape changes (only then). Each milestone's inside first; then the plan, with the
  // milestones as boxes of those sizes: a line leaves each one below its criteria and comes into the
  // ones that wait on it above their number, and ELK routes those lines between the boxes.
  useEffect(() => {
    let live = true;
    void Promise.all(
      shape.milestones.map((m) => {
        const inside = new Set([...m.tasks.map(taskNodeId), gateId(m.id)]);
        const input: ElkInput = {
          id: groupId(m.id),
          layoutOptions: INSIDE,
          children: [...m.tasks.map((t) => ({ id: taskNodeId(t), ...TASK })), { id: gateId(m.id), width: CRITERIA.width, height: criteriaHeight(m.criteria) }],
          edges: shape.edges.filter((e) => inside.has(e.from) && inside.has(e.to)).map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
        };
        return layout(input);
      }),
    )
      .then(async (outs) => {
        const out = new Map(shape.milestones.map((m, i) => [m.id, outs[i]!] as const));
        // The milestones of a row (side by side) all as tall as its tallest, so the row reads as one.
        const tall = new Map(shape.rows.flatMap((row) => row.map((id) => [id, Math.max(...row.map((r) => out.get(r)?.height ?? 0))] as const)));
        const gateOf = (id: string): Placed | undefined => placesOf(out.get(id)!).get(gateId(id));
        const plan = await layout({
          id: 'plan',
          layoutOptions: PLAN,
          children: shape.milestones.map((m) => {
            const width = out.get(m.id)?.width ?? 0;
            const height = tall.get(m.id) ?? 0;
            const gate = gateOf(m.id);
            const exit = gate ? gate.x + gate.width / 2 : width / 2;
            return {
              id: groupId(m.id),
              width,
              height,
              layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
              ports: [
                { id: `in:${m.id}`, x: IN_AT, y: 0, width: 0, height: 0, layoutOptions: { 'elk.port.side': 'NORTH' } },
                { id: `out:${m.id}`, x: exit, y: height, width: 0, height: 0, layoutOptions: { 'elk.port.side': 'SOUTH' } },
              ],
            };
          }),
          edges: shape.edges.filter((e) => e.kind === 'next').map((e) => ({ id: e.id, sources: [`out:${e.from.replace(/^gate:/, '')}`], targets: [`in:${e.to.replace(/^m:/, '')}`] })),
        });
        if (!live) return;
        const places = new Map<string, Placed>();
        const routes = new Map<string, Route>();
        for (const [id, at] of placesOf(plan)) places.set(id, at);
        for (const m of shape.milestones) {
          const box = places.get(groupId(m.id));
          const o = out.get(m.id);
          if (!box || !o) continue;
          for (const [nid, at] of placesOf(o)) places.set(nid, at);
          for (const [eid, r] of routesOf(o)) routes.set(eid, { ...r, points: r.points.map((pt) => ({ x: pt.x + box.x, y: pt.y + box.y })) });
        }
        // A milestone's line starts at its criteria (straight down to the box's edge, then as ELK drew it).
        for (const [eid, r] of routesOf(plan)) {
          const from = shape.edges.find((e) => e.id === eid)?.from.replace(/^gate:/, '');
          const box = from ? places.get(groupId(from)) : undefined;
          const gate = from ? places.get(gateId(from)) : undefined;
          const first = r.points[0];
          routes.set(eid, { ...r, points: box && gate && first ? [{ x: first.x, y: box.y + gate.y + gate.height }, ...r.points] : r.points });
        }
        setLaid({ key: shape.key, places, routes });
        setFailed(false);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [shape.key]);

  const byTask = useMemo(() => new Map(view.milestones.flatMap((m) => m.tasks.map((t) => [t.task.id, t] as const))), [view]);
  const lane = useMemo(() => new Map(shape.milestones.flatMap((m) => m.tasks.map((t) => [taskNodeId(t), m.id] as const))), [shape]);
  // What the picked task waits on, or is waited on by, in other milestones: ringed, not wired across the lanes.
  const linked = useMemo(() => {
    if (!selected) return new Set<string>();
    const me = taskNodeId(selected);
    return new Set(shape.edges.filter((e) => e.kind === 'blocks' && (e.from === me || e.to === me) && lane.get(e.from) !== lane.get(e.to)).map((e) => (e.from === me ? e.to : e.from)));
  }, [shape, lane, selected]);
  const nodes = useMemo<PlanNode[]>(() => {
    if (!laid) return [];
    const out: PlanNode[] = [];
    for (const m of view.milestones) {
      const box = laid.places.get(groupId(m.milestone.id));
      if (!box) continue;
      const current = view.current?.milestone.id === m.milestone.id;
      out.push({ id: groupId(m.milestone.id), type: 'milestone', position: { x: box.x, y: box.y }, style: { width: box.width, height: box.height }, width: box.width, height: box.height, data: { view: m, current }, selectable: false, draggable: false, zIndex: -1 });
      for (const t of m.tasks) {
        const at = laid.places.get(taskNodeId(t.task.id));
        if (!at) continue;
        const key = keys.get(t.task.id);
        const mark = marks.get(t.task.id);
        out.push({
          id: taskNodeId(t.task.id),
          type: 'task',
          parentId: groupId(m.milestone.id),
          position: { x: at.x, y: at.y },
          width: TASK.width,
          height: TASK.height,
          draggable: false,
          data: { view: t, ...(key ? { key } : {}), ...(mark ? { mark } : {}), canStart: startable.has(t.task.id), onStart, selected: selected === t.task.id, linked: linked.has(taskNodeId(t.task.id)) },
        });
      }
      const gate = laid.places.get(gateId(m.milestone.id));
      if (gate) out.push({ id: gateId(m.milestone.id), type: 'gate', parentId: groupId(m.milestone.id), position: { x: gate.x, y: gate.y }, width: gate.width, height: gate.height, draggable: false, data: { view: m, current, selected: selected === gateId(m.milestone.id) } });
    }
    return out;
  }, [laid, view, keys, marks, selected, linked, startable, onStart]);

  const edges = useMemo<PlanEdge[]>(() => {
    if (!laid) return [];
    const finished = (id: string): boolean => {
      const s = byTask.get(id.replace(/^t:/, ''))?.state;
      return s === 'done' || s === 'review' || s === 'canceled';
    };
    const titleOf = (id: string): string => `“${view.milestones.find((m) => m.milestone.id === id.replace(/^(gate|m):/, ''))?.milestone.title ?? id}”`;
    const passed = (gate: string): boolean => view.milestones.find((m) => gateId(m.milestone.id) === gate)?.state === 'passed';
    const working = (id: string): boolean => {
      const s = byTask.get(id.replace(/^t:/, ''))?.state;
      return s === 'running' || s === 'asking' || s === 'idle';
    };
    // The milestones being worked on now: their lines, and the lines into them, are the current path.
    const open = new Set(view.open.map((m) => m.milestone.id));
    const now = (e: (typeof shape.edges)[number]): boolean => open.has(e.kind === 'next' ? e.to.replace(/^m:/, '') : (lane.get(e.from) ?? ''));
    // Only real lines: blockers inside a milestone (across milestones the criteria say what comes first),
    // its last tasks into its criteria, and its criteria into the milestones that wait on them.
    const shown = shape.edges.filter((e) => (e.kind === 'blocks' ? lane.get(e.from) === lane.get(e.to) : laid.routes.has(e.id)));
    return shown.map((e) => {
      const done = e.kind === 'next' ? passed(e.from) : finished(e.from);
      const state: LineData['state'] = done ? 'done' : e.kind !== 'next' && working(e.from) ? 'live' : 'waiting';
      const route = laid.routes.get(e.id);
      const ends = e.kind === 'next' ? { ariaLabel: `${titleOf(e.from)} leads to ${titleOf(e.to)}` } : {};
      return { id: e.id, source: e.from, target: e.to, ...ends, type: 'line', data: { kind: e.kind, state, current: now(e), ...(route ? { route } : {}) } };
    });
  }, [laid, shape, lane, byTask, view]);

  // Framed once laid out: the whole plan if it reads, else the milestones being worked on (else the current one).
  const wrap = useRef<HTMLDivElement>(null);
  /** The viewport that shows these milestones as large as fits (never past 1:1), from the top, centred across. */
  const framing = (ids: readonly string[], least = 0): { x: number; y: number; zoom: number } | undefined => {
    const box = wrap.current;
    const groups = ids.map((id) => laid?.places.get(groupId(id))).filter((g): g is Placed => !!g);
    if (!box || !groups.length) return undefined;
    const x0 = Math.min(...groups.map((g) => g.x));
    const y0 = Math.min(...groups.map((g) => g.y));
    const width = Math.max(...groups.map((g) => g.x + g.width)) - x0;
    const height = Math.max(...groups.map((g) => g.y + g.height)) - y0;
    const zoom = Math.min(1, (box.clientWidth - 2 * MARGIN.side) / width, (box.clientHeight - MARGIN.top - MARGIN.side) / height);
    if (zoom < least) return undefined;
    return { x: (box.clientWidth - width * zoom) / 2 - x0 * zoom, y: MARGIN.top - y0 * zoom, zoom };
  };
  const fit = (ms: number): void => {
    const at = framing(shape.milestones.map((m) => m.id));
    if (at) void flow.setViewport(at, { duration: ms });
  };
  useEffect(() => {
    if (!laid || framed.current) return;
    framed.current = true;
    requestAnimationFrame(() => {
      const open = view.open.map((m) => m.milestone.id);
      const at =
        framing(shape.milestones.map((m) => m.id), READABLE) ??
        framing(open, READABLE) ??
        framing(view.current ? [view.current.milestone.id] : open.slice(0, 1)) ??
        framing(shape.milestones.map((m) => m.id));
      if (at) void flow.setViewport(at, { duration: 0 });
    });
  }, [laid]);

  return (
    <div ref={wrap} className={p.canvas} data-ready={laid ? 'true' : 'false'}>
      <ReactFlow<PlanNode, PlanEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        colorMode={theme}
        minZoom={0.2}
        maxZoom={3}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        zoomOnDoubleClick={false}
        zoomOnScroll={false}
        panOnScroll
        zoomOnPinch
        panOnDrag
        onNodeClick={(_e, n) => (n.type === 'milestone' ? undefined : onSelect(n.type === 'gate' ? n.id : n.id.replace(/^t:/, '')))}
        onPaneClick={() => onSelect(undefined)}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} className={p.dots} />
        <Panel position="bottom-left" className={p.zoom}>
          <IconButton icon="minus" label="Zoom Out" onClick={() => void flow.zoomOut({ duration: 200 })} />
          <IconButton icon="plus" label="Zoom In" onClick={() => void flow.zoomIn({ duration: 200 })} />
          <IconButton icon="outline" label="Fit to View" onClick={() => fit(350)} />
        </Panel>
      </ReactFlow>
      {failed ? <div className={p.canvasNote}>Couldn’t lay this plan out.</div> : !laid ? <div className={p.canvasNote}>Laying out…</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------- nodes

/** Where lines meet a card: never drawn (a line shows itself). */
const Ends = () => (
  <>
    <Handle type="target" position={Position.Left} className={p.handle} isConnectable={false} />
    <Handle type="source" position={Position.Right} className={p.handle} isConnectable={false} />
  </>
);

/** Claude at work on a card: a copper light going round its edge (with the live clock, lib/live-motion.ts). */
function Glow() {
  const glow = useRef<HTMLSpanElement>(null);
  useLive(glow, (t) => glow.current?.style.setProperty('--angle', `${turn(t, 2600)}deg`));
  return <span ref={glow} className={p.glow} aria-hidden="true" />;
}

const TaskNode = memo(function TaskNode({ data }: NodeProps<Node<TaskData, 'task'>>) {
  const { view: t } = data;
  // A started task says how it's doing now (its step and for how long, or that it stopped).
  const now = useClock(t.pulse?.kind === 'working' || t.pulse?.kind === 'command');
  const info = taskWords(t, now);
  const sub = info.sub ?? (t.state === 'asking' ? 'Claude asked you something' : t.forYou && t.state === 'ready' ? 'For you' : undefined);
  return (
    <div
      className={cx(p.task, p[`task_${t.state}`], data.selected && p.taskSelected, data.linked && p.taskLinked, data.mark && p.taskMarked)}
      data-state={t.state}
      data-linked={data.linked ? 'true' : undefined}
      aria-label={`${t.task.title}, ${info.label}`}
    >
      <Ends />
      {t.state === 'running' ? <Glow /> : null}
      <div className={p.taskTop}>
        <TaskStateIcon state={t.state} />
        <span className={p.taskKey}>{data.key ?? t.task.id}</span>
        {data.mark ? <span className={p.markChip}>{data.mark === 'added' ? 'New' : 'Changed'}</span> : null}
        <span className={p.grow} />
        <TaskChatMark {...(t.worktree ? { worktree: t.worktree } : {})} />
        {t.task.estimate ? <span className={p.points}>{t.task.estimate}</span> : null}
        {t.forYou ? <Icon name="person" size={12} className={p.forYou} /> : null}
      </div>
      <div className={p.taskTitle} title={t.task.title}>
        {t.task.title}
      </div>
      <div className={p.taskFoot}>
        {data.canStart ? (
          <button
            type="button"
            className={cx(p.startButton, 'nodrag', 'nopan')}
            onClick={(e) => {
              e.stopPropagation();
              data.onStart(t.task.id);
            }}
          >
            <Icon name={t.forYou ? 'hand' : 'play'} size={9} />
            {t.forYou ? 'Decide…' : 'Start'}
          </button>
        ) : (
          <span className={cx(p.taskState, p[`tone_${info.tone}`])}>{info.label}</span>
        )}
        {sub ? <span className={p.taskSub}>{sub}</span> : null}
      </div>
    </div>
  );
});

const MilestoneNode = memo(function MilestoneNode({ data }: NodeProps<Node<MilestoneData, 'milestone'>>) {
  const m = data.view;
  const info = MILESTONE_STATE[m.state];
  const share = m.state === 'passed' ? 1 : m.total ? m.finished / m.total : 0;
  return (
    <div className={cx(p.milestone, p[`ms_${m.state}`], data.current && p.msCurrent)}>
      <Handle id="in" type="target" position={Position.Top} className={p.handle} isConnectable={false} />
      <Handle id="out" type="source" position={Position.Bottom} className={p.handle} isConnectable={false} />
      <div className={p.msHead}>
        <span className={p.msIndex}>{m.state === 'passed' ? <Icon name="check" size={11} /> : m.index + 1}</span>
        <span className={p.msTitles}>
          <span className={p.msTitle}>{m.milestone.title}</span>
          <span className={p.msSub}>
            <span className={cx(p.msState, p[`tone_${info.tone}`])}>{info.label}</span>
            {m.state !== 'draft' ? (
              <span className={p.msCount}>
                {m.finished}/{m.total}
              </span>
            ) : (
              <span className={p.msCount}>{m.milestone.tasks.length} tasks</span>
            )}
            {m.state !== 'draft' ? (
              <span className={p.msProgress} aria-hidden="true">
                <span className={p.msProgressFill} style={{ width: `${Math.round(share * 100)}%` }} />
              </span>
            ) : null}
            {m.milestone.autonomy ? <span className={p.msAuto}>{AUTONOMY_INFO[m.autonomy].label}</span> : null}
          </span>
        </span>
      </div>
    </div>
  );
});

/**
 * The criteria at a milestone's end (its gate): what must be true to pass it. Claude's check judges them
 * together (its notes are prose), so no criterion is ticked on its own: each is a plain bullet, and the
 * node says once where the milestone stands. Picked, the details say more.
 */
const GateNode = memo(function GateNode({ data }: NodeProps<Node<GateData, 'gate'>>) {
  const m = data.view;
  const criteria = m.milestone.criteria;
  const checked = m.run.check?.verdict === 'pass';
  const label = m.state === 'passed' ? 'Passed' : m.state === 'checking' ? 'Checking…' : m.state === 'failed' ? 'Failed check' : m.state === 'gate' ? (checked ? 'Checked · pass it' : 'Pass it') : 'Not yet';
  // Waiting for you: a soft ring that breathes out (with the live clock, lib/live-motion.ts).
  const gate = useRef<HTMLDivElement>(null);
  useLive(gate, (t) => gate.current?.style.setProperty('--beckon', (1 - breath(t, 2400)).toFixed(3)), m.state === 'gate');
  return (
    <div ref={gate} className={cx(c.criteria, c[`criteria_${m.state}`], data.current && c.criteriaCurrent, data.selected && c.criteriaSelected)} data-criteria={m.milestone.id} data-state={m.state} aria-label={`Criteria of ${m.milestone.title}: ${label}`}>
      <Ends />
      <div className={c.criteriaHead}>
        <span className={c.criteriaMark}>
          <Icon name={m.state === 'passed' ? 'check' : m.state === 'failed' ? 'x' : 'flag'} size={10} />
        </span>
        <span className={c.criteriaTitle}>Criteria</span>
        <span className={c.criteriaState}>{label}</span>
      </div>
      {criteria.length ? (
        <ul className={c.criteriaList}>
          {criteria.map((text, i) => (
            <li key={i} className={c.criterion} title={text}>
              <span className={c.criterionMark} aria-hidden="true" />
              <span className={c.criterionText}>{text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className={c.criteriaNone}>Passes when its tasks are done</div>
      )}
    </div>
  );
});

const NODE_TYPES = { task: TaskNode, milestone: MilestoneNode, gate: GateNode } as const;

// ---------------------------------------------------------------- lines

/** Every line the same thin stroke: done ones in green, the current path darker, a task at work in copper. */
const PlanLine = memo(function PlanLine({ id, source, target, sourceX, sourceY, targetX, targetY, data }: EdgeProps<PlanEdge>) {
  const points: readonly Point[] = data?.route?.points ?? [
    { x: sourceX, y: sourceY },
    { x: (sourceX + targetX) / 2, y: sourceY },
    { x: (sourceX + targetX) / 2, y: targetY },
    { x: targetX, y: targetY },
  ];
  const kind = data?.kind ?? 'blocks';
  const state = data?.state ?? 'waiting';
  return (
    <g data-from={source} data-to={target} data-kind={kind} data-state={state}>
      <BaseEdge id={id} path={roundedPath(points, 10)} className={cx(c.line, c[`line_${state}`], data?.current && c.lineCurrent)} interactionWidth={0} />
    </g>
  );
});

const EDGE_TYPES = { line: PlanLine } as const;
