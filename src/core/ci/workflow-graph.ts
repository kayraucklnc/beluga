import { type Graph, type GraphEdge, type GraphNode, type GraphStatus, MAX_NODES, cleanId } from '../../shared/graph-spec.js';
import { type GhJob, type RunTone, TONE_WORDS, durationWords, fileName, isLive, runTone, spanOf, statusWords } from './model.js';

/**
 * A workflow file as a graph: what starts it, then its jobs, joined by their `needs:`. Given a
 * run's jobs, each job is coloured by how it's going there (a matrix's or a reusable workflow's
 * jobs add up into the one they came from). Takes the YAML already parsed (the Mac app has the
 * parser), so it stays browser-safe and quick to test. Browser-safe.
 */

type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
/** Text with no `${{ … }}` in it (an expression only GitHub can work out). */
const plain = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() && !v.includes('${{') ? v.trim() : undefined);

export interface WorkflowJob {
  readonly id: string;
  /** What GitHub calls it (its `name:`, else its id). */
  readonly name: string;
  readonly needs: readonly string[];
  readonly runsOn?: string;
  /** How many jobs its matrix makes (undefined: no matrix; 0: worked out by an expression). */
  readonly matrix?: number;
  /** A reusable workflow it calls instead of running steps. */
  readonly uses?: string;
  readonly steps: readonly string[];
  readonly condition?: string;
  readonly environment?: string;
}

export interface WorkflowShape {
  readonly name?: string;
  /** What starts it ("push", "pull_request"…), with the branches or schedule when it says. */
  readonly triggers: ReadonlyArray<{ readonly event: string; readonly detail?: string }>;
  readonly jobs: readonly WorkflowJob[];
}

/** What a workflow says, from its parsed YAML; undefined when it isn't one. */
export function readWorkflow(doc: unknown): WorkflowShape | undefined {
  if (!isObj(doc) || !isObj(doc.jobs)) return undefined;
  // YAML 1.1 readers turn a bare `on` into true.
  const on = doc.on ?? doc.true;
  const triggers: Array<{ event: string; detail?: string }> = [];
  if (typeof on === 'string') triggers.push({ event: on });
  else if (Array.isArray(on)) for (const e of strings(on)) triggers.push({ event: e });
  else if (isObj(on)) {
    for (const [event, cfg] of Object.entries(on)) {
      let detail: string | undefined;
      if (event === 'schedule' && Array.isArray(cfg)) detail = cfg.map((c) => (isObj(c) && typeof c.cron === 'string' ? c.cron : '')).filter(Boolean).join(', ') || undefined;
      else if (isObj(cfg)) {
        const branches = strings(cfg.branches);
        const tags = strings(cfg.tags);
        const workflows = strings(cfg.workflows);
        detail = [...branches, ...tags.map((t) => `tag ${t}`), ...workflows].join(', ') || (strings(cfg.paths).length ? 'some paths' : undefined);
      }
      triggers.push(detail ? { event, detail } : { event });
    }
  }
  const jobs: WorkflowJob[] = Object.entries(doc.jobs).flatMap(([id, raw]): WorkflowJob[] => {
    if (!isObj(raw)) return [];
    const runsOn = typeof raw['runs-on'] === 'string' ? raw['runs-on'] : strings(raw['runs-on']).join(', ') || (isObj(raw['runs-on']) ? strings(raw['runs-on'].labels).join(', ') || strings(raw['runs-on'].group).join(', ') : undefined);
    const steps = Array.isArray(raw.steps)
      ? raw.steps.map((st, i) => {
          if (!isObj(st)) return `Step ${i + 1}`;
          if (typeof st.name === 'string') return st.name;
          if (typeof st.uses === 'string') return st.uses;
          if (typeof st.run === 'string') return `Run ${st.run.trim().split('\n')[0]!.slice(0, 60)}`;
          return `Step ${i + 1}`;
        })
      : [];
    const env = typeof raw.environment === 'string' ? raw.environment : isObj(raw.environment) && typeof raw.environment.name === 'string' ? raw.environment.name : undefined;
    const matrix = isObj(raw.strategy) ? matrixSize(raw.strategy.matrix) : undefined;
    return [
      {
        id,
        name: plain(raw.name) ?? id,
        needs: strings(raw.needs),
        ...(runsOn ? { runsOn } : {}),
        ...(matrix !== undefined ? { matrix } : {}),
        ...(typeof raw.uses === 'string' ? { uses: raw.uses } : {}),
        steps,
        ...(typeof raw.if === 'string' || typeof raw.if === 'boolean' ? { condition: String(raw.if) } : {}),
        ...(env ? { environment: env } : {}),
      },
    ];
  });
  const name = plain(doc.name);
  return { ...(name ? { name } : {}), triggers, jobs };
}

/** How many jobs a matrix makes: its lists multiplied, less what it excludes, plus what it includes. */
export function matrixSize(matrix: unknown): number | undefined {
  if (matrix === undefined || matrix === null) return undefined;
  if (!isObj(matrix)) return 0;
  let n = 1;
  let any = false;
  for (const [k, v] of Object.entries(matrix)) {
    if (k === 'include' || k === 'exclude') continue;
    if (Array.isArray(v)) {
      n *= v.length;
      any = true;
    } else if (typeof v === 'string' && v.includes('${{')) return 0;
  }
  const include = Array.isArray(matrix.include) ? matrix.include.length : 0;
  const exclude = Array.isArray(matrix.exclude) ? matrix.exclude.length : 0;
  // Includes that only add values to existing combinations make none of their own: a fair guess.
  return any ? Math.max(0, n - exclude) + (include && !n ? include : 0) : include;
}

/** A run's jobs that came from this workflow job: by its name, with its matrix values, or under it when it calls another workflow. */
export function jobsOf(job: Pick<WorkflowJob, 'id' | 'name'>, jobs: readonly GhJob[]): GhJob[] {
  const names = [...new Set([job.name, job.id])];
  return jobs.filter((j) => names.some((n) => j.name === n || j.name.startsWith(`${n} (`) || j.name.startsWith(`${n} / `)));
}

/** How a group of jobs went, as one: any failed, else any running, else any waiting… */
export function toneOf(jobs: readonly GhJob[]): RunTone | undefined {
  if (!jobs.length) return undefined;
  const tones = new Set(jobs.map(runTone));
  return (['failed', 'running', 'waiting', 'queued', 'cancelled', 'passed', 'skipped'] as const).find((t) => tones.has(t));
}

const STATUS: Readonly<Record<RunTone, GraphStatus>> = { running: 'active', queued: 'todo', waiting: 'review', passed: 'done', failed: 'failed', cancelled: 'idle', skipped: 'idle' };

/** "push · pull_request", the words a trigger node shows. */
const triggerLabel = (t: WorkflowShape['triggers']): string => (t.length ? t.map((x) => x.event).join(' · ') : 'Starts');

/**
 * The workflow as a beluga-graph: a node for what starts it, one per job, a line for each
 * `needs:`. With a run's jobs, each node says how it's going, and how long it took once done.
 */
export function workflowGraph(shape: WorkflowShape, opts: { readonly title?: string; readonly path?: string; readonly jobs?: readonly GhJob[] } = {}): Graph {
  const ids = new Map<string, string>();
  const taken = new Set<string>(['on']);
  for (const j of shape.jobs.slice(0, MAX_NODES - 1)) {
    let id = cleanId(`job:${j.id}`) || `job:${ids.size}`;
    while (taken.has(id)) id = `${id}-`;
    taken.add(id);
    ids.set(j.id, id);
  }
  const trigger: GraphNode = {
    id: 'on',
    type: 'actor',
    label: triggerLabel(shape.triggers).slice(0, 80),
    ...(shape.triggers.some((t) => t.detail) ? { sublabel: shape.triggers.flatMap((t) => (t.detail ? [t.detail] : [])).join(' · ').slice(0, 120) } : {}),
    details: shape.triggers.length ? `**Starts on**\n\n${shape.triggers.map((t) => `- \`${t.event}\`${t.detail ? `: ${t.detail}` : ''}`).join('\n')}` : 'Nothing starts it on its own.',
  };
  const nodes: GraphNode[] = [trigger];
  const edges: GraphEdge[] = [];
  for (const j of shape.jobs) {
    const id = ids.get(j.id);
    if (!id) continue;
    const ran = opts.jobs ? jobsOf(j, opts.jobs) : undefined;
    const tone = ran ? toneOf(ran) : undefined;
    const reusable = j.uses !== undefined;
    const kind = j.matrix !== undefined ? (j.matrix ? `× ${j.matrix}` : 'matrix') : undefined;
    const plan = [kind, reusable ? `calls ${fileName(j.uses!)}` : plain(j.runsOn), !reusable && j.steps.length ? `${j.steps.length} step${j.steps.length === 1 ? '' : 's'}` : undefined].filter(Boolean).join(' · ');
    let sublabel = plan;
    // While it runs the line stays what the job is (its status pill says how it's going): the graph is
    // drawn again only when something starts or ends, not each time GitHub is asked.
    if (ran?.length && !ran.some(isLive)) {
      const started = ran.map((r) => r.startedAt).filter((x): x is number => Boolean(x));
      const ends = ran.map((r) => r.completedAt ?? r.startedAt ?? 0);
      const took = started.length ? Math.max(...ends) - Math.min(...started) : undefined;
      const one = ran.length === 1 ? ran[0]! : undefined;
      const said = one ? statusWords(one) : `${TONE_WORDS[tone!]} · ${ran.length} jobs`;
      sublabel = [said, took !== undefined && took > 0 ? durationWords(took) : undefined].filter(Boolean).join(' · ');
    } else if (opts.jobs && !ran?.length) sublabel = j.condition ? 'Not run (its if: said no)' : 'Not run';
    const lines = [
      j.runsOn ? `**Runs on** \`${j.runsOn}\`` : undefined,
      kind ? `**Matrix** ${j.matrix ? `${j.matrix} jobs` : 'worked out when it runs'}` : undefined,
      j.environment ? `**Environment** ${j.environment}` : undefined,
      j.condition ? `**Only if** \`${j.condition}\`` : undefined,
      j.uses ? `**Calls** \`${j.uses}\`` : undefined,
      j.steps.length ? `**Steps**\n\n${j.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : undefined,
      // Only finished jobs' times: a running one's would redraw the graph each time GitHub is asked.
      ran && ran.length > 1 ? `**Jobs in this run**\n\n${ran.map((r) => `- ${r.name}: ${statusWords(r)}${!isLive(r) && spanOf(r, 0) ? ` (${durationWords(spanOf(r, 0)!)})` : ''}`).join('\n')}` : undefined,
    ].filter(Boolean);
    nodes.push({
      id,
      type: reusable ? (j.uses!.startsWith('./') ? 'file' : 'external') : 'function',
      label: j.name.slice(0, 80),
      ...(sublabel ? { sublabel: sublabel.slice(0, 120) } : {}),
      ...(tone ? { status: STATUS[tone] } : opts.jobs ? { status: 'idle' as const } : {}),
      ...(tone === 'failed' ? { emphasis: true } : {}),
      ...(lines.length ? { details: lines.join('\n\n').slice(0, 4000) } : {}),
      ...(ran?.length === 1 && ran[0]!.url ? { links: [{ label: 'Open on GitHub', href: ran[0]!.url }] } : {}),
    });
    const needs = j.needs.filter((n) => ids.has(n));
    if (!needs.length) edges.push({ id: `on->${id}`, from: 'on', to: id, kind: 'flow' });
    for (const n of needs) edges.push({ id: `${ids.get(n)}->${id}`, from: ids.get(n)!, to: id, kind: 'depends', ...(tone === 'running' ? { animated: true } : {}) });
  }
  const title = opts.title ?? shape.name ?? (opts.path ? fileName(opts.path) : undefined);
  return { ...(title ? { title } : {}), direction: 'right', nodes, edges, steps: [] };
}
