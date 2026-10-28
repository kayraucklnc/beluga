import { describe, expect, it } from 'vitest';
import { parseGraph } from '../src/shared/graph-spec.js';
import type { Dashboard } from '../src/core/sentinel/dashboard-model.js';
import type { RunSummary, Sentinel } from '../src/core/sentinel/model.js';
import { RECIPES } from '../src/core/sentinel/recipes.js';
import { sentinelGraph } from '../src/core/sentinel/workflow.js';

/** BLG-352: a sentinel's workflow as a graph: what starts it, its steps, where results land, what runs after. */

const base = { icon: 'graph', access: 'work', limits: { minutes: 30, pauseAfter: 3 }, notify: 'phone', paused: false, failures: 0, createdAt: 1, updatedAt: 1 } as const;

const chain: Sentinel = {
  ...base,
  id: 'sn_a',
  name: 'Fetch, analyse, send',
  trigger: { kind: 'schedule', every: 'day', at: '08:00', missed: 'catch-up' },
  steps: [
    { id: 'st1', name: 'Fetch the data', kind: 'script', command: '', code: 'print(1)', language: 'python', cwd: 'project', timeoutSec: 120 },
    { id: 'st2', name: 'Analyse it', kind: 'claude', prompt: 'Analyse {{previous}}', where: 'worktree' },
    { id: 'st3', name: 'Send it', kind: 'http', method: 'POST', url: '$RESULTS_URL', headers: { Authorization: 'Bearer $KEY' }, body: '{"r": "{{previous}}"}', timeoutSec: 30 },
    { id: 'st4', name: 'Keep it', kind: 'measure', from: 'previous', metrics: [{ name: 'answer', kind: 'rows', columns: [{ key: 'retry', type: 'action', sentinel: 'sn_c', button: 'Retry' }] }] },
    { id: 'st5', name: 'Tell me', kind: 'notify', phone: true },
  ],
};
const after: Sentinel = { ...base, id: 'sn_b', name: 'When it fails', trigger: { kind: 'after', sentinelId: 'sn_a', on: 'failure' }, steps: [{ id: 'x', name: 'Fix', kind: 'notify', phone: false }] };
const retry: Sentinel = { ...base, id: 'sn_c', name: 'Retry one', trigger: { kind: 'manual' }, steps: [] };
const board: Dashboard = { id: 'db1', name: 'Ops', compare: 'previous', tiles: [{ id: 't1', kind: 'table', width: 3, metric: { sentinelId: 'sn_a', metric: 'answer' } }], createdAt: 1, updatedAt: 1 };

describe('a sentinel as a graph', () => {
  const g = sentinelGraph(chain, { items: [chain, after, retry], dashboards: [board] });

  it('is a graph the screens draw', () => {
    const parsed = parseGraph(JSON.stringify(g));
    expect(parsed.ok).toBe(true);
  });

  it('runs from what starts it through each step, saying what moves', () => {
    expect(g.nodes[0]).toMatchObject({ id: 'on', label: 'Every day at 8:00' });
    expect(g.edges.map((e) => [e.from, e.to, e.label])).toEqual(
      expect.arrayContaining([
        ['on', 'step:st1', 'starts'],
        ['step:st1', 'step:st2', 'what it printed'],
        ['step:st2', 'step:st3', 'its report'],
        ['step:st3', 'step:st4', 'the answer'],
        ['step:st4', 'step:st5', 'what it read (JSON)'],
      ]),
    );
  });

  it('puts Claude’s worktree in a box, and lands results on dashboards and other sentinels', () => {
    expect(g.nodes.find((n) => n.id === 'step:st2')?.group).toBe('worktree');
    expect(g.nodes.some((n) => n.id === 'worktree' && n.type === 'group')).toBe(true);
    expect(g.edges.find((e) => e.to === 'dashboard:db1')).toMatchObject({ from: 'step:st4', label: 'answer' });
    expect(g.edges.find((e) => e.to === 'sentinel:sn_c')).toMatchObject({ from: 'step:st4', label: 'Retry on each row' });
    expect(g.edges.find((e) => e.to === 'sentinel:sn_b')).toMatchObject({ from: 'step:st5', label: 'when it fails' });
  });

  it('never shows a header’s value, only its name', () => {
    const card = g.nodes.find((n) => n.id === 'step:st3')?.details ?? '';
    expect(card).toContain('Authorization');
    expect(card).not.toContain('Bearer');
  });

  it('colours each step by its last run', () => {
    const run = { id: 'r1', sentinelId: 'sn_a', by: 'you', trigger: { kind: 'manual', summary: '' }, state: 'failed', startedAt: 1, headline: '', tasks: [], steps: [{ id: 'st1', state: 'done', startedAt: 1, endedAt: 2001 }, { id: 'st2', state: 'failed', why: 'usage limit' }, { id: 'st3', state: 'skipped' }] } as unknown as RunSummary;
    const ran = sentinelGraph(chain, { run });
    expect(ran.nodes.find((n) => n.id === 'step:st1')).toMatchObject({ status: 'done', sublabel: 'Run a script · 2 s' });
    expect(ran.nodes.find((n) => n.id === 'step:st2')).toMatchObject({ status: 'failed', emphasis: true, sublabel: 'Failed: usage limit' });
    expect(ran.nodes.find((n) => n.id === 'step:st3')?.status).toBe('idle');
  });

  it('draws every recipe', () => {
    for (const r of RECIPES) {
      const s = { ...base, id: r.id, name: r.sentinel.name, trigger: r.sentinel.trigger ?? { kind: 'manual' }, steps: (r.sentinel.steps ?? []).map((st, i) => ({ ...st, id: `s${i}`, name: st.name ?? `Step ${i + 1}` })) } as unknown as Sentinel;
      expect(parseGraph(JSON.stringify(sentinelGraph(s))).ok).toBe(true);
    }
  });
});
