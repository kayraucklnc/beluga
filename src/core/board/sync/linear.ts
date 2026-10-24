import type { IssueStatus, Priority } from '../model.js';
import { type FetchLike, type IssueFields, type Provider, type RemoteIssue, type RemoteTeam, SyncError } from './provider.js';

/**
 * Linear, through its GraphQL API and a personal API key (lin_api_…). The key goes in the
 * Authorization header and nowhere else, and errors carry Beluga's words, never Linear's.
 * Linear can't call us back (no public URL), so autosync asks what changed since the last look.
 */

export const LINEAR_API = 'https://api.linear.app/graphql';
export { LINEAR_KEY, LINEAR_KEY_URL, linearKeyProblem } from '../../../shared/tracker-keys.js';

export interface LinearOptions {
  readonly fetch?: FetchLike;
  /** Where the API is (BELUGA_LINEAR_API, for a fake Linear). */
  readonly base?: string;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxRetries?: number;
  /** Pages of 100 per look (a team with more changes catches up over a few syncs). */
  readonly maxPages?: number;
  readonly now?: () => number;
}

/** A first look brings open issues, and those closed in the last this-many ms. */
const FIRST_LOOK_CLOSED_MS = 14 * 24 * 3600_000;
const DEFAULTS = { timeoutMs: 20_000, maxRetries: 3, maxPages: 10 };
const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Linear's priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
const TO_LINEAR: Record<Priority, number> = { none: 0, urgent: 1, high: 2, medium: 3, low: 4 };
const FROM_LINEAR: readonly Priority[] = ['none', 'urgent', 'high', 'medium', 'low'];

interface State {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly position: number;
}
interface TeamMeta {
  readonly states: readonly State[];
  readonly labels: ReadonlyMap<string, string>;
  readonly estimates: boolean;
  readonly at: number;
}

const ISSUE = `id identifier url title description priority estimate dueDate updatedAt state { id name type } labels(first: 50) { nodes { name } } parent { id }`;

const isReview = (name: string): boolean => /review/i.test(name);

/** A Linear state as the board's status. */
export function statusFromLinear(state: { readonly type: string; readonly name: string }): IssueStatus {
  switch (state.type) {
    case 'unstarted':
      return 'todo';
    case 'started':
      return isReview(state.name) ? 'in_review' : 'in_progress';
    case 'completed':
      return 'done';
    case 'canceled':
      return 'canceled';
    default:
      return 'backlog'; // backlog, triage
  }
}

/** The team's state for a board status: the first of its kind, review by its name. */
export function stateFor(states: readonly State[], status: IssueStatus): State | undefined {
  const sorted = [...states].sort((a, b) => a.position - b.position);
  const of = (type: string): State[] => sorted.filter((s) => s.type === type);
  const started = of('started');
  switch (status) {
    case 'backlog':
      return of('backlog')[0] ?? of('triage')[0] ?? of('unstarted')[0];
    case 'todo':
      return of('unstarted')[0] ?? of('backlog')[0];
    case 'in_progress':
      return started.find((s) => !isReview(s.name)) ?? started[0];
    case 'in_review':
    case 'in_plan':
      return started.find((s) => isReview(s.name)) ?? started.find((s) => !isReview(s.name)) ?? started[0];
    case 'done':
      return of('completed')[0];
    case 'canceled':
      return of('canceled')[0];
  }
}

interface RawIssue {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description?: string | null;
  priority?: number | null;
  estimate?: number | null;
  dueDate?: string | null;
  updatedAt: string;
  state: { id: string; name: string; type: string };
  labels?: { nodes: Array<{ name: string }> };
  parent?: { id: string } | null;
}

function toRemote(raw: RawIssue): RemoteIssue {
  return {
    id: raw.id,
    key: raw.identifier,
    url: raw.url,
    title: raw.title,
    description: raw.description ?? '',
    status: statusFromLinear(raw.state),
    priority: FROM_LINEAR[raw.priority ?? 0] ?? 'none',
    ...(raw.estimate ? { estimate: raw.estimate } : {}),
    ...(raw.dueDate ? { due: raw.dueDate } : {}),
    labels: [...new Set((raw.labels?.nodes ?? []).map((l) => l.name.toLowerCase()))],
    ...(raw.parent?.id ? { parent: raw.parent.id } : {}),
    updatedAt: Date.parse(raw.updatedAt) || 0,
  };
}

export class LinearProvider implements Provider {
  readonly kind = 'linear' as const;
  private readonly meta = new Map<string, TeamMeta>();

  constructor(
    private readonly key: string,
    private readonly opts: LinearOptions = {},
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  async teams(): Promise<{ readonly workspace?: string; readonly teams: readonly RemoteTeam[] }> {
    const data = (await this.call('Teams', `query Teams { viewer { id } organization { name } teams(first: 100) { nodes { id key name } } }`)) as {
      organization?: { name?: string };
      teams: { nodes: RemoteTeam[] };
    };
    const teams = data.teams.nodes.map((t) => ({ id: t.id, key: t.key, name: t.name }));
    return { ...(data.organization?.name ? { workspace: data.organization.name } : {}), teams };
  }

  async changed(teamId: string, since: number | undefined): Promise<readonly RemoteIssue[]> {
    const team = { team: { id: { eq: teamId } } };
    const filter =
      since === undefined
        ? { and: [team, { or: [{ state: { type: { nin: ['completed', 'canceled'] } } }, { updatedAt: { gt: new Date(this.now() - FIRST_LOOK_CLOSED_MS).toISOString() } }] }] }
        : { and: [team, { updatedAt: { gt: new Date(since).toISOString() } }] };
    const out: RemoteIssue[] = [];
    let after: string | undefined;
    for (let page = 0; page < (this.opts.maxPages ?? DEFAULTS.maxPages); page++) {
      const data = (await this.call('Changed', `query Changed($filter: IssueFilter, $after: String) { issues(first: 100, after: $after, filter: $filter, orderBy: updatedAt) { nodes { ${ISSUE} } pageInfo { hasNextPage endCursor } } }`, { filter, after })) as {
        issues: { nodes: RawIssue[]; pageInfo: { hasNextPage: boolean; endCursor?: string | null } };
      };
      out.push(...data.issues.nodes.map(toRemote));
      if (!data.issues.pageInfo.hasNextPage || !data.issues.pageInfo.endCursor) break;
      after = data.issues.pageInfo.endCursor;
    }
    return out.sort((a, b) => a.updatedAt - b.updatedAt);
  }

  async create(teamId: string, fields: IssueFields): Promise<RemoteIssue> {
    const input = { teamId, ...(await this.input(teamId, fields)) };
    const data = (await this.call('Create', `mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE} } } }`, { input })) as { issueCreate: { success: boolean; issue?: RawIssue } };
    if (!data.issueCreate.success || !data.issueCreate.issue) throw new SyncError('remote', 'Linear didn’t create the issue.');
    return toRemote(data.issueCreate.issue);
  }

  async update(teamId: string, id: string, fields: Partial<IssueFields>): Promise<RemoteIssue> {
    const input = await this.input(teamId, fields);
    // Nothing Linear takes (an estimate where the team doesn't use them): read it as it is.
    if (!Object.keys(input).length) {
      const data = (await this.call('Issue', `query Issue($id: String!) { issue(id: $id) { ${ISSUE} } }`, { id })) as { issue: RawIssue };
      return toRemote(data.issue);
    }
    const data = (await this.call('Update', `mutation Update($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${ISSUE} } } }`, { id, input })) as { issueUpdate: { success: boolean; issue?: RawIssue } };
    if (!data.issueUpdate.success || !data.issueUpdate.issue) throw new SyncError('remote', 'Linear didn’t save the change.');
    return toRemote(data.issueUpdate.issue);
  }

  /** The fields as Linear's input: a state for the status, label ids (made when missing), no estimate where the team doesn't use them. */
  private async input(teamId: string, f: Partial<IssueFields>): Promise<Record<string, unknown>> {
    const meta = f.status !== undefined || f.labels !== undefined || f.estimate !== undefined ? await this.teamMeta(teamId) : undefined;
    const input: Record<string, unknown> = {};
    if (f.title !== undefined) input.title = f.title;
    if (f.description !== undefined) input.description = f.description;
    if (f.priority !== undefined) input.priority = TO_LINEAR[f.priority];
    if ('due' in f) input.dueDate = f.due ?? null;
    if ('parent' in f) input.parentId = f.parent ?? null;
    if ('estimate' in f && meta?.estimates) input.estimate = f.estimate ?? null;
    if (f.status !== undefined && meta) {
      const state = stateFor(meta.states, f.status);
      if (state) input.stateId = state.id;
    }
    if (f.labels !== undefined && meta) input.labelIds = await this.labelIds(teamId, meta, f.labels);
    return input;
  }

  private async labelIds(teamId: string, meta: TeamMeta, names: readonly string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const name of names) {
      const known = meta.labels.get(name.toLowerCase());
      if (known) {
        ids.push(known);
        continue;
      }
      const data = (await this.call('Label', `mutation Label($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id name } } }`, { input: { name, teamId } })) as { issueLabelCreate: { success: boolean; issueLabel?: { id: string } } };
      const made = data.issueLabelCreate.issueLabel?.id;
      if (!made) continue;
      (meta.labels as Map<string, string>).set(name.toLowerCase(), made);
      ids.push(made);
    }
    return ids;
  }

  /** The team's states, labels (its own and the workspace's) and whether it estimates: asked once every ten minutes. */
  private async teamMeta(teamId: string): Promise<TeamMeta> {
    const kept = this.meta.get(teamId);
    if (kept && this.now() - kept.at < 10 * 60_000) return kept;
    const data = (await this.call(
      'Team',
      `query Team($id: String!) { team(id: $id) { issueEstimationType states(first: 100) { nodes { id name type position } } labels(first: 250) { nodes { id name } } } issueLabels(first: 250, filter: { team: { null: true } }) { nodes { id name } } }`,
      { id: teamId },
    )) as { team: { issueEstimationType?: string; states: { nodes: State[] }; labels: { nodes: Array<{ id: string; name: string }> } }; issueLabels?: { nodes: Array<{ id: string; name: string }> } };
    const labels = new Map<string, string>();
    for (const l of [...(data.issueLabels?.nodes ?? []), ...data.team.labels.nodes]) labels.set(l.name.toLowerCase(), l.id);
    const meta: TeamMeta = { states: data.team.states.nodes, labels, estimates: (data.team.issueEstimationType ?? 'notUsed') !== 'notUsed', at: this.now() };
    this.meta.set(teamId, meta);
    return meta;
  }

  /** One GraphQL call, retried when Linear is busy or down (1s, 2s, 4s). */
  private async call(operationName: string, query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
    const doFetch = this.opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    const sleep = this.opts.sleep ?? sleepMs;
    const retries = this.opts.maxRetries ?? DEFAULTS.maxRetries;
    for (let attempt = 0; ; attempt++) {
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await doFetch(this.opts.base ?? LINEAR_API, {
          method: 'POST',
          headers: { authorization: this.key, 'content-type': 'application/json' },
          body: JSON.stringify({ operationName, query, variables }),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULTS.timeoutMs),
        });
      } catch {
        if (attempt < retries) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new SyncError('offline', 'Couldn’t reach Linear. Beluga tries again in a minute.');
      }
      let body: { data?: unknown; errors?: Array<{ extensions?: { type?: string; code?: string } }> } | undefined;
      try {
        body = (await res.json()) as typeof body;
      } catch {
        body = undefined;
      }
      const kinds = (body?.errors ?? []).map((e) => `${e.extensions?.type ?? ''} ${e.extensions?.code ?? ''}`.toLowerCase());
      const limited = res.status === 429 || kinds.some((k) => k.includes('ratelimited'));
      if ((limited || res.status >= 500) && attempt < retries) {
        const after = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 401 || res.status === 403 || kinds.some((k) => k.includes('authentication') || k.includes('forbidden'))) {
        throw new SyncError('auth', 'Linear doesn’t accept this key (it was revoked, or copied only in part). Connect a new one.');
      }
      if (limited) throw new SyncError('rate_limited', 'Linear asked Beluga to slow down. It tries again later.');
      if (res.status >= 500) throw new SyncError('remote', 'Linear had a problem answering. Beluga tries again later.');
      if (body?.errors?.length || !body?.data) throw new SyncError('remote', 'Linear turned the request down.');
      return body.data;
    }
  }
}
