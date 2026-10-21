import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { AUTONOMIES, AUTONOMY_INFO, type Autonomy, MAX_PARALLEL, shownBody } from '@klaud/core/plans/model.js';
import type { PlanView } from '@klaud/core/plans/progress.js';
import { Icon } from '../components/Icon.js';
import { ActionsDropdown, type ActionItem } from '../components/SpecMenu.js';
import { Button, Empty, IconButton, Segmented, cx } from '../components/ui.js';
import { copyText } from '../lib/copy.js';
import { openSheet } from '../lib/sheets.js';
import { MilestoneBar, TonePill } from './marks.js';
import { PlanChat } from './PlanChat.js';
import { PlanDetails } from './PlanDetails.js';
import { PlanOutline } from './PlanOutline.js';
import { bars, changeWords, nextWords, planStatus, titleOf } from './plans-model.js';
import { usePlanActions, usePlanView, usePlans } from './use-plans.js';
import p from './plans.module.css';

const PlanCanvas = lazy(() => import('./PlanCanvas.js'));

type Display = 'graph' | 'outline';
const PREFS = 'klaud.plan.v1';

function readPrefs(): { display: Display; chat: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS) ?? '{}') as { display?: string; chat?: boolean };
    return { display: raw.display === 'outline' ? 'outline' : 'graph', chat: raw.chat !== false };
  } catch {
    return { display: 'graph', chat: true };
  }
}

/**
 * A plan's page: what it is and the one thing it waits for, at the top; the plan as a living graph
 * (or an outline) in the middle; and the conversation with Claude beside it, where the plan is
 * talked through and changed. Everything else is a click away (⋯, a task, a gate).
 */
export function PlanPage({ id }: { id: string }) {
  const plan = usePlans().plans.find((x) => x.id === id);
  const view = usePlanView(plan);
  const [prefs, setPrefsState] = useState(readPrefs);
  const setPrefs = (patch: Partial<typeof prefs>): void => {
    const next = { ...prefs, ...patch };
    setPrefsState(next);
    try {
      localStorage.setItem(PREFS, JSON.stringify(next));
    } catch {
      // Kept for now.
    }
  };
  const [picked, setPicked] = useState<string>();
  const { openList } = usePlanActions();
  // A task taken out of the plan isn't picked any more.
  useEffect(() => {
    if (picked && view && !picked.startsWith('gate:') && !view.milestones.some((m) => m.tasks.some((t) => t.task.id === picked))) setPicked(undefined);
  }, [view, picked]);
  if (!plan || !view) return <Empty icon="flag" title="This plan is gone" detail="It was deleted. Its tasks stay on the board." action={<Button onClick={() => openList()}>Back to Plans</Button>} />;
  return <Page view={view} prefs={prefs} setPrefs={setPrefs} picked={picked} setPicked={setPicked} />;
}

function Page({ view, prefs, setPrefs, picked, setPicked }: { view: PlanView; prefs: { display: Display; chat: boolean }; setPrefs: (p: Partial<{ display: Display; chat: boolean }>) => void; picked?: string; setPicked: (id: string | undefined) => void }) {
  const { plan } = view;
  const { api, act, openList, openWorktree } = usePlanActions();
  const body = shownBody(plan);
  const status = planStatus(view);
  const keys = useMemo(() => new Map(view.milestones.flatMap((m) => m.tasks.flatMap((t) => (t.issue ? [[t.task.id, t.issue.key] as const] : [])))), [view]);
  const startable = useMemo(() => {
    if (!plan.body || plan.draft || view.active.length >= plan.maxParallel || !view.open.length) return new Set<string>();
    const step = new Set(view.open.filter((m) => m.autonomy === 'step').map((m) => m.milestone.id));
    return new Set(view.ready.filter((t) => t.forYou || plan.paused || step.has(t.milestoneId)).map((t) => t.task.id));
  }, [view, plan]);
  const start = useCallback((taskId: string) => void act(() => api.startTask(plan.id, taskId)), [plan.id, act, api]);
  const next = view.next;
  const words = nextWords(next);

  const primary = ((): { label: string; run: () => void; icon?: 'check' | 'play' } | undefined => {
    switch (next.kind) {
      case 'approve':
        return body?.milestones.length ? { label: 'Approve Plan', icon: 'check', run: () => void act(() => api.approve(plan.id), 'Plan approved: its tasks are on the board') } : undefined;
      case 'review_changes':
        return { label: 'Apply Changes', icon: 'check', run: () => void act(() => api.approve(plan.id), 'Changes applied') };
      case 'resume':
        return { label: 'Resume', icon: 'play', run: () => void act(() => api.setPaused(plan.id, false)) };
      case 'start':
        return { label: words.title, icon: 'play', run: () => next.tasks.forEach((t) => void act(() => api.startTask(plan.id, t.task.id))) };
      case 'pass':
        return { label: 'Pass Milestone', icon: 'check', run: () => void act(() => api.pass(plan.id, next.milestone.milestone.id)) };
      case 'failed':
        return { label: 'Not Yet…', run: () => openSheet({ kind: 'plan_send_back', planId: plan.id, milestone: next.milestone.milestone.id }) };
      case 'answer':
        return next.tasks[0]?.worktree ? { label: `Answer in ${next.tasks[0].issue?.key ?? 'Its Worktree'}`, run: () => openWorktree(next.tasks[0]!.worktree!) } : undefined;
      default:
        return undefined;
    }
  })();

  const more: ActionItem[] = [
    { label: prefs.chat ? 'Hide the Conversation' : 'Show the Conversation', onSelect: () => setPrefs({ chat: !prefs.chat }) },
    ...(plan.body && plan.status === 'active' ? [{ label: plan.paused ? 'Resume' : 'Pause', onSelect: () => void act(() => api.setPaused(plan.id, !plan.paused)) }] : []),
    { label: 'Run at Once', submenu: [1, 2, 3, 4, 6, MAX_PARALLEL].map((n) => ({ label: `${n} ${n === 1 ? 'task' : 'tasks'}`, checked: plan.maxParallel === n, onSelect: () => void act(() => api.setParallel(plan.id, n)) })), onSelect: () => undefined },
    ...(next.kind === 'pass' ? [{ label: 'Not Yet…', onSelect: () => openSheet({ kind: 'plan_send_back', planId: plan.id, milestone: next.milestone.milestone.id }) }] : []),
    ...(next.kind === 'failed' || next.kind === 'checking'
      ? [
          { label: 'Check Again', onSelect: () => void act(() => api.recheck(plan.id, next.milestone.milestone.id)) },
          { label: 'Pass Anyway', onSelect: () => void act(() => api.pass(plan.id, next.milestone.milestone.id)) },
        ]
      : []),
    { label: 'Copy as Markdown', separate: true, onSelect: () => void copyText(markdownOf(view)) },
    { label: 'Planning Style…', onSelect: () => openSheet({ kind: 'plan_style' }) },
    ...(plan.draft ? [{ label: plan.body ? 'Discard Changes' : 'Discard Draft', danger: true, separate: true, onSelect: () => openSheet({ kind: 'confirm', title: plan.body ? 'Discard the proposed changes?' : 'Discard this draft?', message: plan.body ? 'The plan stays as you approved it.' : 'Nothing was put on the board, so nothing else changes.', confirm: 'Discard', destructive: true, run: () => void act(() => api.discard(plan.id)) }) }] : []),
    ...(plan.body ? [{ label: 'Delete Plan…', danger: true, separate: !plan.draft, onSelect: () => openSheet({ kind: 'confirm', title: `Delete “${titleOf(plan)}”?`, message: 'Its tasks stay on the board; only the plan goes.', confirm: 'Delete', destructive: true, run: () => void act(() => api.remove(plan.id)).then(() => openList(plan.projectId)) }) }] : []),
  ];

  return (
    <div className={p.page}>
      <header className={p.pageHead}>
        <div className={p.headMain}>
          <button type="button" className={p.back} onClick={() => openList(plan.projectId)} aria-label="All Plans">
            <Icon name="back" size={12} />
            Plans
          </button>
          <div className={p.titleRow}>
            <TitleField value={titleOf(plan)} onSave={(title) => void act(() => api.edit(plan.id, [{ op: 'retitle', title }]))} />
            <TonePill tone={status.tone} live={status.tone === 'claude'}>
              {status.label}
            </TonePill>
          </div>
          <div className={p.subRow}>
            {view.milestones.length && plan.body ? <MilestoneBar items={bars(view)} /> : null}
            <span className={p.nextLine}>{plan.body ? (words.detail ? `${words.title} · ${words.detail}` : words.title) : body?.milestones.length ? `${view.milestones.length} milestones · ${view.total} tasks · a draft, not on the board yet` : 'Claude is writing the plan…'}</span>
          </div>
        </div>
        <div className={p.headActions}>
          <Segmented<Autonomy> label="Runs" value={plan.autonomy} onChange={(a) => void act(() => api.setAutonomy(plan.id, a))} options={AUTONOMIES.map((a) => ({ value: a, label: AUTONOMY_INFO[a].label, hint: AUTONOMY_INFO[a].hint }))} />
          <ActionsDropdown items={more}>
            <IconButton icon="more" label="Plan Options" />
          </ActionsDropdown>
          {primary ? (
            <Button variant="primary" size="small" {...(primary.icon ? { icon: primary.icon } : {})} onClick={primary.run}>
              {primary.label}
            </Button>
          ) : next.kind === 'checking' ? (
            <Button size="small" disabled>
              Claude is checking…
            </Button>
          ) : null}
        </div>
      </header>
      {plan.body && plan.draft ? (
        <div className={p.changes} role="status">
          <Icon name="wand" size={13} />
          <strong>Claude proposes changes</strong>
          <span>{changeWords(plan)}</span>
          <span className={p.grow} />
          <Button size="small" variant="quiet" onClick={() => void act(() => api.discard(plan.id))}>
            Discard
          </Button>
          <Button size="small" variant="primary" onClick={() => void act(() => api.approve(plan.id), 'Changes applied')}>
            Apply Changes
          </Button>
        </div>
      ) : null}
      <div className={cx(p.split, prefs.chat && p.splitChat)}>
        <div className={p.stage}>
          <div className={p.stageTools}>
            <Segmented<Display>
              label="Show"
              iconOnly
              value={prefs.display}
              onChange={(display) => setPrefs({ display })}
              options={[
                { value: 'graph', label: 'Graph', icon: 'graph' },
                { value: 'outline', label: 'Outline', icon: 'outline' },
              ]}
            />
            {!prefs.chat ? (
              <Button size="small" variant="quiet" icon="claude" onClick={() => setPrefs({ chat: true })}>
                Talk to Claude
              </Button>
            ) : null}
          </div>
          {!body?.milestones.length ? (
            <div className={p.writing}>
              <WritingSkeleton />
              <p>Claude is reading the code and writing the plan. It shows up here as it’s written.</p>
            </div>
          ) : prefs.display === 'graph' ? (
            <Suspense fallback={<div className={p.canvasNote}>Laying out…</div>}>
              <PlanCanvas view={view} keys={keys} selected={picked} onSelect={setPicked} onStart={start} startable={startable} />
            </Suspense>
          ) : (
            <PlanOutline view={view} keys={keys} selected={picked} onSelect={setPicked} startable={startable} />
          )}
          {picked ? <PlanDetails view={view} picked={picked} canStart={startable.has(picked)} onClose={() => setPicked(undefined)} /> : null}
        </div>
        {prefs.chat ? <PlanChat channel={plan.home} draft={!plan.body || Boolean(plan.draft)} onClose={() => setPrefs({ chat: false })} /> : null}
      </div>
    </div>
  );
}

/** The plan's name, changed in place. */
function TitleField({ value, onSave }: { value: string; onSave: (title: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const save = (): void => {
    if (text.trim() && text.trim() !== value) onSave(text.trim());
    else setText(value);
  };
  return (
    <input
      className={cx(p.title, 'selectable')}
      aria-label="Plan name"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** While Claude writes the first plan: milestone boxes that shimmer. */
function WritingSkeleton() {
  return (
    <div className={p.skeleton} aria-hidden="true">
      {[3, 2, 2].map((n, i) => (
        <div key={i} className={p.skMilestone} style={{ animationDelay: `${i * 140}ms` }}>
          <div className={p.skHead} />
          {Array.from({ length: n }, (_, j) => (
            <div key={j} className={p.skTask} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** The plan as Markdown (to paste somewhere). */
function markdownOf(view: PlanView): string {
  const body = shownBody(view.plan);
  if (!body) return '';
  const lines = [`# ${body.title}`, '', body.goal, ''];
  for (const m of view.milestones) {
    lines.push(`## ${m.index + 1}. ${m.milestone.title}`, '');
    if (m.milestone.goal) lines.push(m.milestone.goal, '');
    for (const t of m.tasks) lines.push(`- [${t.state === 'done' ? 'x' : ' '}] ${t.issue ? `${t.issue.key} ` : ''}${t.task.title}${t.task.blockedBy.length ? ` (after ${t.task.blockedBy.join(', ')})` : ''}`);
    if (m.milestone.criteria.length) lines.push('', '**Passes when:**', ...m.milestone.criteria.map((c) => `- ${c}`));
    lines.push('');
  }
  return lines.join('\n');
}
