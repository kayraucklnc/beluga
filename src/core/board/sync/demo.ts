import type { IssueFields, Provider, RemoteIssue } from './provider.js';

/**
 * The demo's pretend Linear: any key of the right shape opens "Acme", whose Engineering team has
 * a few issues already. Nothing goes online, and what the board sends stays here in memory.
 */
export function demoLinear(): Provider {
  let n = 0;
  let clock = Date.now() - 3 * 3600_000;
  const issues = new Map<string, RemoteIssue>();
  const put = (fields: Partial<RemoteIssue> & { title: string }, id = `demo-${++n}`): RemoteIssue => {
    const was = issues.get(id);
    const issue: RemoteIssue = { id, key: was?.key ?? `ENG-${40 + n}`, url: was?.url ?? `https://linear.app/acme/issue/ENG-${40 + n}`, description: '', status: 'todo', priority: 'none', labels: [], ...was, ...fields, updatedAt: (clock = Math.max(clock + 1, Date.now())) };
    issues.set(id, issue);
    return issue;
  };
  put({ title: 'Customers can export invoices as PDF', status: 'backlog', priority: 'medium', labels: ['billing'], description: 'Finance asked for PDF invoices.\n\n## Acceptance criteria\n\n- [ ] An Export button on each invoice\n- [ ] The PDF has the logo and VAT number' });
  put({ title: 'Rate-limit the public API', status: 'todo', priority: 'high', labels: ['api'], estimate: 3, description: 'Per key, 100 requests a minute.' });
  return {
    kind: 'linear',
    teams: async () => ({ workspace: 'Acme', teams: [{ id: 'demo-eng', key: 'ENG', name: 'Engineering' }, { id: 'demo-design', key: 'DES', name: 'Design' }] }),
    changed: async (team, since) => (team === 'demo-eng' ? [...issues.values()].filter((i) => since === undefined || i.updatedAt > since).sort((a, b) => a.updatedAt - b.updatedAt) : []),
    create: async (_team, f: IssueFields) => put({ ...f }),
    update: async (_team, id, f: Partial<IssueFields>) => {
      const was = issues.get(id);
      if (!was) throw new Error('No such issue');
      const next: Record<string, unknown> = { ...was, ...f };
      for (const [k, v] of Object.entries(f)) if (v === undefined) delete next[k];
      issues.set(id, next as unknown as RemoteIssue);
      return put({ title: (next as { title: string }).title }, id);
    },
  };
}
