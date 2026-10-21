import '@xyflow/react/dist/base.css';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, BaseEdge, type Edge, type EdgeProps, Handle, type Node, type NodeProps, Panel, Position, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { AUTONOMY_INFO } from '@klaud/core/plans/model.js';
import type { MilestoneView, PlanView, TaskView } from '@klaud/core/plans/progress.js';
import { IconButton, cx } from '../components/ui.js';
import { Icon } from '../components/Icon.js';
import { reducedMotion, useDocTheme } from '../components/markdown/use-doc-theme.js';
import { type ElkInput, type Placed, type Point, type Route, placesOf, roundedPath, routesOf } from '../components/graph/graph-model.js';
import { layout } from '../components/graph/layout.js';
import { MILESTONE_STATE, TASK_STATE, changeMarks, gateId, graphShape, groupId, taskNodeId } from './plans-model.js';
import { TaskStateIcon } from './marks.js';
import p from './plans.module.css';

/**
 * A plan as a living graph: each milestone a box, left to right, its tasks inside laid out by what
 * waits on what, and a gate at its end that opens the next. Tasks Claude is working on glow and
 * say what it's doing; finished ones tick; a gate waiting for you is the one thing in the accent.
 * The layout (ELK) depends only on the plan's shape, so work moving on never moves anything.
 */

const TASK = { width: 252, height: 92 };
const GATE = { width: 150, height: 44 };
const HEAD = 62;
/** Room between milestones (the gate's line runs through it). */
const LANE_GAP = 40;

interface TaskData extends Record<string, unknown> {
  readonly view: TaskView;
  readonly key?: string;
  readonly mark?: 'added' | 'changed';
  readonly canStart: boolean;
  readonly onStart: (taskId: string) => void;
  readonly selected: boolean;
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
  readonly motion: boolean;
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

function Canvas({ view, keys, selected, onSelect, onStart, startable }: PlanCanvasProps) {
  const theme = useDocTheme();
  const motion = !reducedMotion();
  const flow = useReactFlow<PlanNode, PlanEdge>();
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
        let y = 24;
        // Lanes as wide as the widest, so the plan reads as one column of steps.
        const wide = Math.max(420, ...outs.map((o) => o.width ?? 0));
        outs.forEach((out, i) => {
          const m = shape.milestones[i]!;
          const width = wide;
          const height = out.height ?? 0;
          places.set(groupId(m.id), { x: 24, y, width, height });
          for (const [id, at] of placesOf(out)) places.set(id, at);
          for (const [id, r] of routesOf(out)) routes.set(id, { ...r, points: r.points.map((pt) => ({ x: pt.x + 24, y: pt.y + y })) });
          y += height + LANE_GAP;
        });
        setLaid({ key: shape.key, places, routes });
        setFailed(false);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [shape.key]);

  const byTask = useMemo(() => new Map(view.milestones.flatMap((m) => m.tasks.map((t) => [t.task.id, t] as const))), [view]);
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
          data: { view: t, ...(key ? { key } : {}), ...(mark ? { mark } : {}), canStart: startable.has(t.task.id), onStart, selected: selected === t.task.id },
        });
      }
      const gate = laid.places.get(gateId(m.milestone.id));
      if (gate) out.push({ id: gateId(m.milestone.id), type: 'gate', parentId: groupId(m.milestone.id), position: { x: gate.x, y: gate.y }, width: GATE.width, height: GATE.height, draggable: false, data: { view: m, current, selected: selected === gateId(m.milestone.id) } });
    }
    return out;
  }, [laid, view, keys, marks, selected, startable, onStart]);

  const edges = useMemo<PlanEdge[]>(() => {
    if (!laid) return [];
    const finished = (id: string): boolean => {
      const s = byTask.get(id.replace(/^t:/, ''))?.state;
      return s === 'done' || s === 'review' || s === 'canceled';
    };
    const passed = (gate: string): boolean => view.milestones.find((m) => gateId(m.milestone.id) === gate)?.state === 'passed';
    const working = (id: string): boolean => {
      const s = byTask.get(id.replace(/^t:/, ''))?.state;
      return s === 'running' || s === 'asking' || s === 'idle';
    };
    const lane = new Map(shape.milestones.flatMap((m) => m.tasks.map((t) => [taskNodeId(t), m.id] as const)));
    // A blocker in an earlier milestone is drawn only for the task you picked (the gates already say what comes first).
    const shown = shape.edges.filter((e) => e.kind !== 'blocks' || lane.get(e.from) === lane.get(e.to) || (selected && (e.from === taskNodeId(selected) || e.to === taskNodeId(selected))));
    return shown.map((e) => {
      const done = e.kind === 'next' ? passed(e.from) : finished(e.from);
      const state: LineData['state'] = done ? 'done' : e.kind !== 'next' && working(e.from) ? 'live' : 'waiting';
      const route = laid.routes.get(e.id);
      const handles = e.kind === 'next' ? { sourceHandle: 'down', targetHandle: 'top' } : {};
      const across = e.kind === 'blocks' && lane.get(e.from) !== lane.get(e.to);
      return { id: e.id, source: e.from, target: e.to, type: 'line', ...handles, zIndex: across ? 10 : 0, data: { kind: e.kind, state, motion, ...(route ? { route } : {}) } };
    });
  }, [laid, shape, byTask, view, motion, selected]);

  // Framed once laid out (and when the frame changes size a lot: the conversation folded away).
  const wrap = useRef<HTMLDivElement>(null);
  /** The plan framed so it reads: as wide as fits (never tiny), from the top, the current milestone in view. */
  const frame = (ms: number): void => {
    const box = wrap.current;
    if (!laid || !box) return;
    const groups = [...laid.places].filter(([id]) => id.startsWith('m:')).map(([, at]) => at);
    const width = Math.max(...groups.map((g) => g.x + g.width)) + 24;
    const height = Math.max(...groups.map((g) => g.y + g.height)) + 24;
    const zoom = Math.max(0.55, Math.min(1, box.clientWidth / width, Math.max(box.clientHeight / height, box.clientWidth / width)));
    const current = view.current ? laid.places.get(groupId(view.current.milestone.id)) : undefined;
    // From the top (below the view switch), unless the current milestone would be out of sight.
    const top = current && (current.y + current.height) * zoom + 52 > box.clientHeight ? -(current.y - 24) * zoom + 52 : 40;
    const left = width * zoom <= box.clientWidth ? (box.clientWidth - width * zoom) / 2 : 0;
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

const Ends = ({ hidden }: { hidden?: boolean }) => (
  <>
    <Handle type="target" position={Position.Left} className={p.handle} isConnectable={false} style={hidden ? { opacity: 0 } : undefined} />
    <Handle type="source" position={Position.Right} className={p.handle} isConnectable={false} style={hidden ? { opacity: 0 } : undefined} />
  </>
);

const TaskNode = memo(function TaskNode({ data }: NodeProps<Node<TaskData, 'task'>>) {
  const { view: t } = data;
  const info = TASK_STATE[t.state];
  const sub = t.state === 'running' && t.step ? t.step : t.state === 'blocked' || t.state === 'later' ? t.why : t.state === 'asking' ? 'Claude asked you something' : t.forYou && t.state === 'ready' ? 'For you' : undefined;
  return (
    <div
      className={cx(p.task, p[`task_${t.state}`], data.selected && p.taskSelected, data.mark && p.taskMarked)}
      data-state={t.state}
      aria-label={`${t.task.title}, ${info.label}`}
    >
      <Ends hidden />
      {t.state === 'running' ? <span className={p.glow} aria-hidden="true" /> : null}
      <div className={p.taskTop}>
        <TaskStateIcon state={t.state} />
        <span className={p.taskKey}>{data.key ?? t.task.id}</span>
        {data.mark ? <span className={p.markChip}>{data.mark === 'added' ? 'New' : 'Changed'}</span> : null}
        <span className={p.grow} />
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
      <Handle id="top" type="target" position={Position.Top} className={p.handle} isConnectable={false} style={{ left: 27 }} />
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
            {m.milestone.autonomy ? <span className={p.msAuto}>{AUTONOMY_INFO[m.autonomy].label}</span> : null}
          </span>
        </span>
      </div>
      <div className={p.msProgress} aria-hidden="true">
        <span className={p.msProgressFill} style={{ width: `${Math.round(share * 100)}%` }} />
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
      <Ends hidden />
      <Handle id="down" type="source" position={Position.Bottom} className={p.handle} isConnectable={false} />
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
    <>
      <BaseEdge id={id} path={path} className={cx(p.line, p[`line_${kind}`], p[`line_${state}`])} interactionWidth={0} />
      {state === 'live' && data?.motion ? (
        <circle r={2.6} className={p.lineDot}>
          <animateMotion dur="1.8s" repeatCount="indefinite" path={path} />
        </circle>
      ) : null}
    </>
  );
});

const EDGE_TYPES = { line: PlanLine } as const;
