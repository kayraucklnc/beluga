import '@xyflow/react/dist/base.css';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, BaseEdge, type Edge, type EdgeProps, Handle, type Node, type NodeProps, Panel, Position, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { AUTONOMY_INFO } from '@klaud/core/plans/model.js';
import type { MilestoneView, PlanView, TaskView } from '@klaud/core/plans/progress.js';
import { IconButton, cx } from '../components/ui.js';
import { Icon } from '../components/Icon.js';
import { useDocTheme } from '../components/markdown/use-doc-theme.js';
import { type ElkInput, type Placed, type Point, type Route, placesOf, roundedPath, routesOf } from '../components/graph/graph-model.js';
import { layout } from '../components/graph/layout.js';
import { useSharpZoom } from '../components/graph/sharp-zoom.js';
import { MILESTONE_STATE, TASK_STATE, changeMarks, gateId, graphShape, groupId, taskNodeId } from './plans-model.js';
import { TaskChatMark, TaskStateIcon } from './marks.js';
import p from './plans.module.css';

/**
 * A plan as a living graph: each milestone a box, its tasks inside laid out by what waits on what,
 * and a gate at its end. Milestones that run side by side sit side by side in a row; a line runs
 * from each milestone down to the ones that wait on it. Tasks Claude is working on glow and
 * say what it's doing; finished ones tick; a gate waiting for you is the one thing in the accent.
 * The layout (ELK) depends only on the plan's shape, so work moving on never moves anything.
 */

const TASK = { width: 252, height: 92 };
const GATE = { width: 150, height: 44 };
const HEAD = 62;
/** Room between milestones. */
const LANE_GAP = 40;
/** A milestone's line to one two or more rows down runs down the right of the lanes, never across them. */
const GUTTER = 22;
const GUTTER_STEP = 10;
/** A task's line to its gate is drawn only from the column next to it (not across empty columns). */
const NEAR_GATE = 80;

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
  /** Width the milestone lines take right of the lanes. */
  readonly gutter: number;
}

function Canvas({ view, keys, selected, onSelect, onStart, startable }: PlanCanvasProps) {
  const theme = useDocTheme();
  const flow = useReactFlow<PlanNode, PlanEdge>();
  useSharpZoom();
  const shape = useMemo(() => graphShape(view.plan), [view.plan]);
  const [laid, setLaid] = useState<Laid>();
  const [failed, setFailed] = useState(false);
  const framed = useRef(false);
  const marks = useMemo(() => changeMarks(view.plan), [view.plan]);

  // Lay out when the shape changes (only then): each milestone on its own (its tasks left to right
  // by what waits on what, its gate at the end), then the milestones stacked top to bottom.
  useEffect(() => {
    let live = true;
    void Promise.all(
      shape.milestones.map((m) => {
        const inside = new Set([...m.tasks.map(taskNodeId), gateId(m.id)]);
        const input: ElkInput = {
          id: groupId(m.id),
          layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': 'RIGHT',
            'elk.layered.spacing.nodeNodeBetweenLayers': '56',
            'elk.spacing.nodeNode': '16',
            'elk.layered.spacing.edgeNodeBetweenLayers': '20',
            'elk.edgeRouting': 'ORTHOGONAL',
            'elk.spacing.edgeEdge': '10',
            'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
            'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
            // What can start at once lines up on the left; the gate is always last.
            'elk.layered.layering.strategy': 'LONGEST_PATH_SOURCE',
            'elk.padding': `[top=${HEAD + 12},left=20,bottom=20,right=20]`,
          },
          children: [...m.tasks.map((t) => ({ id: taskNodeId(t), ...TASK })), { id: gateId(m.id), ...GATE }],
          edges: shape.edges.filter((e) => inside.has(e.from) && inside.has(e.to)).map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
        };
        return layout(input);
      }),
    )
      .then((outs) => {
        if (!live) return;
        const places = new Map<string, Placed>();
        const routes = new Map<string, Route>();
        const out = new Map(shape.milestones.map((m, i) => [m.id, outs[i]!] as const));
        const rowOf = new Map(shape.rows.flatMap((row, r) => row.map((id) => [id, r] as const)));
        // Rows top to bottom; the milestones of a row (they run side by side) left to right, each as
        // wide as its tasks need, all as tall as the row's tallest.
        let y = 24;
        for (const row of shape.rows) {
          const height = Math.max(...row.map((id) => out.get(id)?.height ?? 0));
          let x = 24;
          for (const id of row) {
            const o = out.get(id);
            if (!o) continue;
            const width = Math.max(row.length > 1 ? 340 : 420, o.width ?? 0);
            places.set(groupId(id), { x, y, width, height });
            for (const [nid, at] of placesOf(o)) places.set(nid, at);
            for (const [eid, r] of routesOf(o)) routes.set(eid, { ...r, points: r.points.map((pt) => ({ x: pt.x + x, y: pt.y + y })) });
            x += width + LANE_GAP;
          }
          y += height + LANE_GAP;
        }
        // A milestone → each one that waits on it: bottom to top through the gap between the rows;
        // past a row in between, down a track right of every lane (never across a lane or its tasks).
        const boxes = [...places].filter(([id]) => id.startsWith('m:')).map(([, at]) => at);
        const right = Math.max(...boxes.map((b) => b.x + b.width));
        const far = shape.edges.filter((e) => e.kind === 'next' && (rowOf.get(e.to.replace(/^m:/, '')) ?? 0) - (rowOf.get(e.from.replace(/^gate:/, '')) ?? 0) > 1);
        for (const e of shape.edges) {
          if (e.kind !== 'next') continue;
          const from = places.get(groupId(e.from.replace(/^gate:/, '')));
          const to = places.get(e.to);
          if (!from || !to) continue;
          const s = { x: from.x + from.width / 2, y: from.y + from.height };
          const t = { x: to.x + to.width / 2, y: to.y };
          const below = s.y + LANE_GAP / 2;
          const above = t.y - LANE_GAP / 2;
          const track = far.indexOf(e);
          const points =
            track < 0
              ? [s, { x: s.x, y: above }, { x: t.x, y: above }, t]
              : [s, { x: s.x, y: below }, { x: right + GUTTER + track * GUTTER_STEP, y: below }, { x: right + GUTTER + track * GUTTER_STEP, y: above }, { x: t.x, y: above }, t];
          routes.set(e.id, { points });
        }
        setLaid({ key: shape.key, places, routes, gutter: far.length ? GUTTER + far.length * GUTTER_STEP : 0 });
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
      if (gate) out.push({ id: gateId(m.milestone.id), type: 'gate', parentId: groupId(m.milestone.id), position: { x: gate.x, y: gate.y }, width: GATE.width, height: GATE.height, draggable: false, data: { view: m, current, selected: selected === gateId(m.milestone.id) } });
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
    const nearGate = (e: (typeof shape.edges)[number]): boolean => {
      const task = laid.places.get(e.from);
      const gate = laid.places.get(e.to);
      return Boolean(task && gate && gate.x - (task.x + task.width) <= NEAR_GATE);
    };
    // Only real lines: blockers inside a milestone (across milestones the gates say what comes first),
    // the last column of tasks into the gate, and a gate into the milestones that wait on it.
    const shown = shape.edges.filter((e) => (e.kind === 'blocks' ? lane.get(e.from) === lane.get(e.to) : e.kind === 'finish' ? nearGate(e) : laid.routes.has(e.id)));
    return shown.map((e) => {
      const done = e.kind === 'next' ? passed(e.from) : finished(e.from);
      const state: LineData['state'] = done ? 'done' : e.kind !== 'next' && working(e.from) ? 'live' : 'waiting';
      const route = laid.routes.get(e.id);
      // Drawn from the milestone's head (its gate is what it waits on, so the line keeps its state).
      const ends = e.kind === 'next' ? { source: groupId(e.from.replace(/^gate:/, '')), sourceHandle: 'out', targetHandle: 'in', ariaLabel: `${titleOf(e.from)} leads to ${titleOf(e.to)}` } : { source: e.from };
      return { id: e.id, ...ends, target: e.to, type: 'line', data: { kind: e.kind, state, ...(route ? { route } : {}) } };
    });
  }, [laid, shape, lane, byTask, view]);

  // Framed once laid out (and when the frame changes size a lot: the conversation folded away).
  const wrap = useRef<HTMLDivElement>(null);
  /** The plan framed so it reads: as wide as fits (never tiny), from the top, the current milestone in view. */
  const frame = (ms: number): void => {
    const box = wrap.current;
    if (!laid || !box) return;
    const groups = [...laid.places].filter(([id]) => id.startsWith('m:')).map(([, at]) => at);
    const width = Math.max(...groups.map((g) => g.x + g.width)) + laid.gutter + 24;
    const height = Math.max(...groups.map((g) => g.y + g.height)) + 24;
    const zoom = Math.max(0.55, Math.min(1, box.clientWidth / width, Math.max(box.clientHeight / height, box.clientWidth / width)));
    const current = view.current ? laid.places.get(groupId(view.current.milestone.id)) : undefined;
    // From the top (below the view switch), unless the current milestone would be out of sight.
    const top = current && (current.y + current.height) * zoom + 52 > box.clientHeight ? -(current.y - 24) * zoom + 52 : 40;
    // Wider than the view (milestones side by side): from the left, unless the current milestone would be out of sight.
    const left = width * zoom <= box.clientWidth ? (box.clientWidth - width * zoom) / 2 : current && (current.x + current.width) * zoom > box.clientWidth ? -(current.x - 24) * zoom + 16 : 0;
    void flow.setViewport({ x: left, y: top, zoom }, { duration: ms });
  };
  useEffect(() => {
    if (!laid || framed.current) return;
    framed.current = true;
    requestAnimationFrame(() => frame(0));
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
        maxZoom={1.8}
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
          <IconButton icon="outline" label="Fit to View" onClick={() => void flow.fitView({ padding: 0.06, maxZoom: 1, duration: 350 })} />
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

const TaskNode = memo(function TaskNode({ data }: NodeProps<Node<TaskData, 'task'>>) {
  const { view: t } = data;
  const info = TASK_STATE[t.state];
  const sub = t.state === 'running' && t.step ? t.step : t.state === 'blocked' || t.state === 'later' ? t.why : t.state === 'asking' ? 'Claude asked you something' : t.forYou && t.state === 'ready' ? 'For you' : undefined;
  return (
    <div
      className={cx(p.task, p[`task_${t.state}`], data.selected && p.taskSelected, data.linked && p.taskLinked, data.mark && p.taskMarked)}
      data-state={t.state}
      data-linked={data.linked ? 'true' : undefined}
      aria-label={`${t.task.title}, ${info.label}`}
    >
      <Ends />
      {t.state === 'running' ? <span className={p.glow} aria-hidden="true" /> : null}
      <div className={p.taskTop}>
        <TaskStateIcon state={t.state} />
        <span className={p.taskKey}>{data.key ?? t.task.id}</span>
        {data.mark ? <span className={p.markChip}>{data.mark === 'added' ? 'New' : 'Changed'}</span> : null}
        <span className={p.grow} />
        <TaskChatMark {...(t.worktree ? { worktree: t.worktree } : {})} />
        {t.task.estimate ? <span className={p.points}>{t.task.estimate}</span> : null}
        {t.forYou ? <Icon name="person" size={12} className={p.forYou} /> : null}
      </div>
      <div className={p.taskTitle}>{t.task.title}</div>
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
            <Icon name="play" size={9} />
            Start
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

const GateNode = memo(function GateNode({ data }: NodeProps<Node<GateData, 'gate'>>) {
  const m = data.view;
  const n = m.milestone.criteria.length;
  const check = m.run.check;
  const label = m.state === 'passed' ? 'Passed' : m.state === 'checking' ? 'Checking…' : m.state === 'failed' ? 'Failed check' : m.state === 'gate' ? 'Pass it' : n ? `${n} ${n === 1 ? 'criterion' : 'criteria'}` : 'Milestone';
  return (
    <div className={cx(p.gate, p[`gate_${m.state}`], data.selected && p.gateSelected)} aria-label={`Gate of ${m.milestone.title}: ${label}`}>
      <Ends />
      <span className={p.gateMark}>
        <Icon name={m.state === 'passed' ? 'check' : m.state === 'failed' ? 'x' : 'flag'} size={11} />
      </span>
      <span className={p.gateLabel}>{label}</span>
      {check && m.state !== 'passed' ? <span className={cx(p.gateCheck, check.verdict === 'pass' ? p.tone_ok : p.tone_error)}>{check.verdict === 'pass' ? '✓' : '!'}</span> : null}
    </div>
  );
});

const NODE_TYPES = { task: TaskNode, milestone: MilestoneNode, gate: GateNode } as const;

// ---------------------------------------------------------------- lines

const PlanLine = memo(function PlanLine({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<PlanEdge>) {
  const down = data?.kind === 'next' || targetY > sourceY + 60;
  // Down to the next milestone: below the gate, across the gap between lanes, into the next one.
  const mid = data?.kind === 'next' ? targetY - LANE_GAP / 2 : (sourceY + targetY) / 2;
  const points: readonly Point[] =
    data?.route?.points ??
    (down
      ? [
          { x: sourceX, y: sourceY },
          { x: sourceX, y: mid },
          { x: targetX, y: mid },
          { x: targetX, y: targetY },
        ]
      : [
          { x: sourceX, y: sourceY },
          { x: (sourceX + targetX) / 2, y: sourceY },
          { x: (sourceX + targetX) / 2, y: targetY },
          { x: targetX, y: targetY },
        ]);
  const path = roundedPath(points, 10);
  const kind = data?.kind ?? 'blocks';
  const state = data?.state ?? 'waiting';
  return (
      <BaseEdge id={id} path={path} className={cx(p.line, p[`line_${kind}`], p[`line_${state}`])} interactionWidth={0} />
  );
});

const EDGE_TYPES = { line: PlanLine } as const;
