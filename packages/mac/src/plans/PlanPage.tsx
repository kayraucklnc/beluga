import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AUTONOMIES, AUTONOMY_INFO, type Autonomy, MAX_PARALLEL, type Plan, TESTS_AT, TESTS_AT_INFO, shownBody } from '@klaud/core/plans/model.js';
import { type PlanView, tidyOffer } from '@klaud/core/plans/progress.js';
import { CONTINUE_PROMPT, decodeFailure, resetWords } from '@klaud/shared/run-failure.js';
import { formatDuration } from '@klaud/shared/text.js';
import { activityOf } from '@klaud/ui/workspace-models.js';
import { useNow } from '../chat/Items.js';
import { Icon } from '../components/Icon.js';
import { ActionsDropdown, type ActionItem } from '../components/SpecMenu.js';
import { usePrefs } from '../lib/prefs.js';
import { PLAN_CHAT_TOGGLE } from '../lib/panel.js';
import { ResizeHandle } from '../layout/panel/ResizeHandle.js';
import { taskChatsItem } from '../layout/plan-task-chats.js';
import { Button, Empty, IconButton, Segmented, cx } from '../components/ui.js';
import { copyText } from '../lib/copy.js';
import { useApp, useKlaud } from '../lib/klaud.js';
import { openSheet } from '../lib/sheets.js';
import { mod, openExternal } from '../lib/system.js';
import { MilestoneBar, PlanProgress, Said, TonePill } from './marks.js';
import { PlanChat } from './PlanChat.js';
import { FEED, PlanDetails } from './PlanDetails.js';
import { PlanOutline } from './PlanOutline.js';
import { CHAT_DEFAULT, DEFAULT_PLAN_LAYOUT, type Display, PLAN_LAYOUT_KEY, type PlanLayout, chatOpen, clampChatWidth, readPlanLayout, setChatOpen } from './plan-layout.js';
import { barColumns, changeWords, headline, nextWords, titleOf } from './plans-model.js';
import { useConversationLoaded, usePlanActions, usePlanView, usePlans } from './use-plans.js';
import p from './plans.module.css';

const PlanCanvas = lazy(() => import('./PlanCanvas.js'));

function readPrefs(): PlanLayout {
  try {
    return readPlanLayout(JSON.parse(localStorage.getItem(PLAN_LAYOUT_KEY) ?? '{}'));
  } catch {
    return DEFAULT_PLAN_LAYOUT;
  }
}

/**
 * A plan's page: what it is and the one thing it waits for, at the top; the plan as a living graph
 * (or an outline) in the middle; and the conversation with Claude beside it, where the plan is
 * talked through and changed. Everything else is a click away (⋯, a task, a gate).
 */
export function PlanPage({ id, task }: { id: string; task?: string }) {
  const plan = usePlans().plans.find((x) => x.id === id);
  const view = usePlanView(plan);
  const [prefs, setPrefsState] = useState(readPrefs);
  const setPrefs = useCallback((change: (layout: PlanLayout) => PlanLayout): void => {
    setPrefsState((was) => {
      const next = change(was);
      try {
        localStorage.setItem(PLAN_LAYOUT_KEY, JSON.stringify(next));
      } catch {
        // Kept for now.
      }
      return next;
    });
  }, []);
  const [picked, setPicked] = useState<string | undefined>(task);
  // Opened at a task (a notification about it): that task is picked.
  useEffect(() => {
    if (task) setPicked(task);
  }, [task]);
  const { openList } = usePlanActions();
  // A task taken out of the plan isn't picked any more.
  useEffect(() => {
    if (picked && view && picked !== FEED && !picked.startsWith('gate:') && !view.milestones.some((m) => m.tasks.some((t) => t.task.id === picked))) setPicked(undefined);
  }, [view, picked]);
  if (!plan || !view) return <Empty icon="flag" title="This plan is gone" detail="It was deleted. Its tasks stay on the board." action={<Button onClick={() => openList()}>Back to Plans</Button>} />;
  return <Page view={view} prefs={prefs} setPrefs={setPrefs} picked={picked} setPicked={setPicked} />;
}

/**
 * Your usage limit stopped the plan: when it goes on by itself, and Resume now. Klaud resumes the
 * head Claude and each paused task once the limit resets (see core/plans/watchdog.ts).
 */
function LimitPause({ view }: { view: PlanView }) {
  const { plan } = view;
  const { api, act } = usePlanActions();
  const { client } = useKlaud();
  const paused = view.active.filter((t) => t.pulse?.kind === 'paused');
  // The head Claude's own last turn, when your limit stopped it.
  const home = useApp((st) => {
    const card = st.log.findLast((l) => l.type === 'agent' && l.channel === plan.home);
    const f = card?.type === 'agent' && card.status === 'error' ? decodeFailure(card.text) : undefined;
    return f?.kind === 'usage_limit' ? (f.resetsAt ?? 0) : undefined;
  });
  if (plan.status !== 'active' || (!paused.length && home === undefined)) return null;
  const until = Math.max(home ?? 0, ...paused.map((t) => (t.pulse?.kind === 'paused' ? t.pulse.until : 0)));
  const resume = (): void => {
    if (home !== undefined) void act(() => client.api.session.submit(CONTINUE_PROMPT, { channel: plan.home, urgent: true }));
    for (const t of paused) void act(() => api.resumeTask(plan.id, t.task.id));
  };
  return (
    <div className={p.changes} role="status">
      <Icon name="clock" size={13} />
      <strong>Paused: usage limit</strong>
      <span>{until > Date.now() ? `resumes at ${resetWords(until)}` : 'resuming as usage comes back'}</span>
      <span className={p.grow} />
      <Button size="small" variant="primary" icon="play" onClick={resume}>
        Resume now
      </Button>
    </div>
  );
}

function Page({ view, prefs, setPrefs, picked, setPicked }: { view: PlanView; prefs: PlanLayout; setPrefs: (change: (layout: PlanLayout) => PlanLayout) => void; picked?: string; setPicked: (id: string | undefined) => void }) {
  const { plan } = view;
  const chat = chatOpen(prefs, plan.id);
  const showChat = useCallback((open: boolean) => setPrefs((l) => setChatOpen(l, plan.id, open)), [plan.id, setPrefs]);
  // ⌥⌘0 (and View › Show Panel): on a plan's page its right side is the chat.
  useEffect(() => {
    const toggle = (): void => setPrefs((l) => setChatOpen(l, plan.id, !chatOpen(l, plan.id)));
    document.addEventListener(PLAN_CHAT_TOGGLE, toggle);
    return () => document.removeEventListener(PLAN_CHAT_TOGGLE, toggle);
  }, [plan.id, setPrefs]);
  const { api, act, openList, openWorktree } = usePlanActions();
  // The plan's conversation (its chat, the head Claude's last turn) loads with the page, the chat shown or not.
  useConversationLoaded(plan.home);
  const uiPrefs = usePrefs();
  const body = shownBody(plan);
  const keys = useMemo(() => new Map(view.milestones.flatMap((m) => m.tasks.flatMap((t) => (t.issue ? [[t.task.id, t.issue.key] as const] : [])))), [view]);
  const startable = useMemo(() => {
    if (!plan.body || plan.draft || view.active.length >= plan.maxParallel || !view.open.length) return new Set<string>();
    const step = new Set(view.open.filter((m) => m.autonomy === 'step').map((m) => m.milestone.id));
    return new Set(view.ready.filter((t) => t.forYou || plan.paused || step.has(t.milestoneId)).map((t) => t.task.id));
  }, [view, plan]);
  // The chat's width: dragged (live), else the one you left it at, never past half the plan's area.
  const split = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number>();
  const splitWidth = (): number => split.current?.clientWidth ?? window.innerWidth;
  const [areaWidth, setAreaWidth] = useState(0);
  useLayoutEffect(() => {
    const el = split.current;
    if (!el) return;
    setAreaWidth(el.clientWidth);
    const watch = new ResizeObserver(() => setAreaWidth(el.clientWidth));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const chatWidth = drag ?? clampChatWidth(prefs.chatWidth, areaWidth || window.innerWidth);
  const start = useCallback((taskId: string) => void act(() => api.startTask(plan.id, taskId)), [plan.id, act, api]);
  const next = view.next;
  const words = nextWords(next);
  const line = headline(view);
  // Claude is writing the first plan: one placeholder and one line say so, nothing else.
  const drafting = !plan.body && !body?.milestones.length;

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
      case 'ship':
        // One pull request for the whole plan (plan/<slug> → main); once open, merged on GitHub.
        if (next.pr?.state === 'OPEN') return { label: 'Merge on GitHub', icon: 'check', run: () => void act(() => api.mergePr(plan.id), `Merged #${next.pr!.number}: the plan’s tasks are Done`) };
        return { label: 'Open PR', run: () => void act(() => api.openPr(plan.id), 'Opened the plan’s pull request') };
      case 'answer':
        return next.tasks[0]?.worktree ? { label: `Answer in ${next.tasks[0].issue?.key ?? 'Its Worktree'}`, run: () => openWorktree(next.tasks[0]!.worktree!) } : undefined;
      case 'stalled':
        return { label: words.title, icon: 'play', run: () => next.tasks.forEach((t) => void act(() => api.resumeTask(plan.id, t.task.id))) };
      default:
        return undefined;
    }
  })();

  const more: ActionItem[] = [
    ...(plan.body && plan.status === 'active' ? [{ label: plan.paused ? 'Resume' : 'Pause', onSelect: () => void act(() => api.setPaused(plan.id, !plan.paused)) }] : []),
    { label: 'Run at Once', submenu: [1, 2, 3, 4, 6, MAX_PARALLEL].map((n) => ({ label: `${n} ${n === 1 ? 'task' : 'tasks'}`, checked: plan.maxParallel === n, onSelect: () => void act(() => api.setParallel(plan.id, n)) })), onSelect: () => undefined },
    { label: 'When to Run Tests', submenu: TESTS_AT.map((t) => ({ label: TESTS_AT_INFO[t].label, hint: TESTS_AT_INFO[t].hint, checked: plan.testsAt === t, onSelect: () => void act(() => api.setTestsAt(plan.id, t), t === 'end' ? 'From now on, milestone checks skip the test suites; they all run once, in the final step' : 'From now on, each milestone’s check runs the full suites once, on its combined work') })), onSelect: () => undefined },
    ...(next.kind === 'stalled' ? next.tasks.flatMap((t) => (t.worktree ? [{ label: `Open ${t.issue?.key ?? 'Its'} Chat`, onSelect: () => openWorktree(t.worktree!) }] : [])) : []),
    ...(next.kind === 'pass' ? [{ label: 'Not Yet…', onSelect: () => openSheet({ kind: 'plan_send_back', planId: plan.id, milestone: next.milestone.milestone.id }) }] : []),
    ...(next.kind === 'failed' || next.kind === 'checking'
      ? [
          { label: 'Check Again', onSelect: () => void act(() => api.recheck(plan.id, next.milestone.milestone.id)) },
          { label: 'Pass Anyway', onSelect: () => void act(() => api.pass(plan.id, next.milestone.milestone.id)) },
        ]
      : []),
    ...(next.kind === 'ship'
      ? [
          ...(next.pr ? [{ label: `View PR #${next.pr.number}`, onSelect: () => void openExternal(next.pr!.url) }] : []),
          ...(next.pr?.state === 'CLOSED' ? [{ label: 'Open PR Again', onSelect: () => void act(() => api.openPr(plan.id), 'Opened the plan’s pull request') }] : []),
          { label: 'Merge into Main Locally', onSelect: () => openSheet({ kind: 'confirm', title: `Merge ${next.branch} into main here?`, message: 'The main folder must be on main with no uncommitted changes. The plan’s tasks go to Done.', confirm: 'Merge', run: () => void act(() => api.mergeLocal(plan.id), 'Merged into main: the plan’s tasks are Done') }) },
        ]
      : []),
    ...(plan.status === 'active' ? [taskChatsItem(plan.id, uiPrefs)] : []),
    { label: 'Copy as Markdown', separate: true, onSelect: () => void copyText(markdownOf(view)) },
    { label: 'Planning Style…', onSelect: () => openSheet({ kind: 'plan_style' }) },
    ...(plan.draft ? [{ label: plan.body ? 'Discard Changes' : 'Discard Draft', danger: true, separate: true, onSelect: () => openSheet({ kind: 'confirm', title: plan.body ? 'Discard the proposed changes?' : 'Discard this draft?', message: plan.body ? 'The plan stays as you approved it.' : 'Nothing was put on the board, so nothing else changes.', confirm: 'Discard', destructive: true, run: () => void act(() => api.discard(plan.id)) }) }] : []),
    ...(plan.body ? [{ label: 'Delete Plan…', danger: true, separate: !plan.draft, onSelect: () => openSheet({ kind: 'confirm', title: `Delete “${titleOf(plan)}”?`, message: 'Its tasks stay on the board; only the plan goes.', confirm: 'Delete', destructive: true, run: () => void act(() => api.remove(plan.id)).then(() => openList(plan.projectId)) }) }] : []),
  ];

  return (
    <div className={p.page}>
      <header className={p.pageHead}>
        <div className={p.headMain}>
          <div className={p.titleRow}>
            <IconButton icon="back" label="All Plans" className={p.back} onClick={() => openList(plan.projectId)} />
            <TitleField value={titleOf(plan)} onSave={(title) => void act(() => api.edit(plan.id, [{ op: 'retitle', title }]))} />
          </div>
          {drafting ? null : (
            <>
              {view.milestones.length && plan.body ? <PlanProgress columns={barColumns(view)} /> : null}
              <button type="button" className={p.saidButton} onClick={() => setPicked(picked === FEED ? undefined : FEED)} aria-label={`${line.who === 'you' ? 'You: ' : ''}${line.text}. Show what happened`}>
                <Said line={line} />
              </button>
            </>
          )}
        </div>
        <div className={p.headActions}>
          {/* How it runs: nothing to run while Claude writes it. A real decision: its sheet says what changes. */}
          {drafting ? null : (
            <Button size="small" variant="quiet" icon="gauge" title={AUTONOMY_INFO[plan.autonomy].hint} onClick={() => openSheet({ kind: 'plan_mode', planId: plan.id })}>
              Runs on {AUTONOMY_INFO[plan.autonomy].label}
              {view.milestones.some((m) => m.milestone.autonomy && m.milestone.autonomy !== plan.autonomy) ? ' (mixed)' : ''}
            </Button>
          )}
          {/* The chat beside the plan, in and out: always here, whichever way it is. */}
          <IconButton icon="claude" label={chat ? 'Hide the Chat' : 'Show the Chat'} keys={`⌥${mod()}0`} active={chat} onClick={() => showChat(!chat)} />
          <ActionsDropdown items={more}>
            <IconButton icon="more" label="Plan Options" />
          </ActionsDropdown>
          {primary ? (
            <Button variant="primary" size="small" {...(primary.icon ? { icon: primary.icon } : {})} onClick={primary.run}>
              {primary.label}
            </Button>
          ) : null}
        </div>
      </header>
      <LimitPause view={view} />
      <TidyOffer view={view} />
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
      <div ref={split} className={cx(p.split, chat && p.splitChat)} style={chat ? { gridTemplateColumns: `minmax(0, 1fr) ${chatWidth}px` } : undefined}>
        <div className={p.stage}>
          <div className={p.stageTools}>
            {drafting ? null : (
              <Segmented<Display>
                label="Show"
                value={prefs.display}
                onChange={(display) => setPrefs((l) => ({ ...l, display }))}
                options={[
                  { value: 'graph', label: 'Canvas', hint: 'The plan as a graph' },
                  { value: 'outline', label: 'List', hint: 'Milestone by milestone' },
                ]}
              />
            )}
            {drafting ? null : (
              <Button size="small" variant="quiet" icon="clock" onClick={() => setPicked(picked === FEED ? undefined : FEED)} aria-pressed={picked === FEED}>
                What Happened
              </Button>
            )}
          </div>
          {!body?.milestones.length ? (
            <Drafting plan={plan} />
          ) : prefs.display === 'graph' ? (
            <Suspense fallback={<div className={p.canvasNote}>Laying out…</div>}>
              <PlanCanvas view={view} keys={keys} selected={picked} onSelect={setPicked} onStart={start} startable={startable} />
            </Suspense>
          ) : (
            <PlanOutline view={view} keys={keys} selected={picked} onSelect={setPicked} startable={startable} />
          )}
          {picked ? <PlanDetails view={view} picked={picked} canStart={startable.has(picked)} onClose={() => setPicked(undefined)} /> : null}
        </div>
        {chat ? (
          <div className={p.chatSide}>
            <ResizeHandle
              axis="x"
              label="Resize the chat"
              className={p.chatEdge}
              onMove={(x) => setDrag(clampChatWidth((split.current?.getBoundingClientRect().right ?? window.innerWidth) - x, splitWidth()))}
              onEnd={() => {
                if (drag !== undefined) setPrefs((l) => ({ ...l, chatWidth: drag }));
                setDrag(undefined);
              }}
              onReset={() => setPrefs((l) => ({ ...l, chatWidth: CHAT_DEFAULT }))}
              onStep={(dir) => setPrefs((l) => ({ ...l, chatWidth: clampChatWidth(chatWidth + dir * 24, splitWidth()) }))}
            />
            <PlanChat channel={plan.home} draft={!plan.body || Boolean(plan.draft)} drafting={drafting} onClose={() => showChat(false)} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The plan's name, changed in place: wraps instead of clipping (descenders and long names show whole); Enter saves. */
function TitleField({ value, onSave }: { value: string; onSave: (title: string) => void }) {
  const [text, setText] = useState(value);
  const box = useRef<HTMLTextAreaElement>(null);
  // What you typed and haven't saved: a name arriving meanwhile (your last rename coming back) never overwrites it.
  const typed = useRef(false);
  useEffect(() => {
    if (!typed.current) setText(value);
  }, [value]);
  // As tall as its lines: on every change and whenever a new width changes the wrapping.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = (): void => {
      el.style.height = '0px';
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    let width = el.clientWidth;
    const watch = new ResizeObserver(() => {
      // Next frame: resizing the box inside its own observer's callback is a ResizeObserver loop.
      if (el.clientWidth !== width) (width = el.clientWidth), cancelAnimationFrame(frame), (frame = requestAnimationFrame(fit));
    });
    let frame = 0;
    watch.observe(el);
    return () => (watch.disconnect(), cancelAnimationFrame(frame));
  }, [text]);
  const save = (): void => {
    if (typed.current && text.trim() && text.trim() !== value) onSave(text.trim());
    else setText(value);
    typed.current = false;
  };
  return (
    <textarea
      ref={box}
      className={cx(p.title, 'selectable')}
      aria-label="Plan name"
      rows={1}
      spellCheck={false}
      value={text}
      onChange={(e) => ((typed.current = true), setText(e.target.value.replace(/\s*\n\s*/g, ' ')))}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === 'Escape') {
          typed.current = false;
          setText(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * While Claude writes the first plan: the outline of three milestone columns, drawn softly inside
 * the canvas, and the one line that says what's going on (how long it's been at it).
 */
function Drafting({ plan }: { plan: Plan }) {
  const project = useApp((s) => s.projects.find((x) => x.id === plan.projectId)?.name);
  const activity = useApp((s) => activityOf(s.log, plan.home));
  const now = useNow(true);
  const since = activity.startedAt ?? plan.createdAt;
  const fresh = now - plan.createdAt < 20_000;
  const line = activity.running
    ? `Claude is reading ${project ?? 'the code'} and writing the plan · ${formatDuration(Math.max(0, now - since))}`
    : fresh
      ? 'Claude is starting on the plan…'
      : 'Claude isn’t writing the plan right now. Tell it what to plan in the conversation.';
  return (
    <div className={p.writing}>
      <div className={p.skeleton} data-live={activity.running || fresh ? 'true' : undefined} aria-hidden="true">
        {[3, 2, 2].map((n, i) => (
          <div key={i} className={p.skMilestone} style={{ animationDelay: `${i * 220}ms` }}>
            <div className={p.skHead} />
            {Array.from({ length: n }, (_, j) => (
              <div key={j} className={p.skTask} />
            ))}
          </div>
        ))}
      </div>
      <p className={p.writingLine} role="status">
        {line}
      </p>
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

/**
 * The plan adopted a branch after some milestones passed: their tasks still In Review can be merged
 * into it and their worktrees cleared away, but only on your Yes (never by itself, nor on a restart).
 */
function TidyOffer({ view }: { view: PlanView }) {
  const { api, act } = usePlanActions();
  const tasks = tidyOffer(view);
  if (!tasks.length) return null;
  const plan = view.plan;
  return (
    <div className={p.changes} role="status" aria-label="Tidy up">
      <Icon name="branch" size={13} />
      <strong>
        Tidy up {tasks.length} merged task {tasks.length === 1 ? 'worktree' : 'worktrees'}?
      </strong>
      <span title={tasks.map((t) => `${t.issue!.key} ${t.task.title}`).join('\n')}>
        {tasks.map((t) => t.issue!.key).join(', ')}: their milestones passed before {plan.branch} was the plan’s branch. Tidy Up merges each into it, then archives its worktree (the conversation stays) and deletes its branch only if merged.
      </span>
      <span className={p.grow} />
      <Button size="small" variant="quiet" onClick={() => void act(() => api.tidyUp(plan.id, false), 'Left as they are')}>
        No
      </Button>
      <Button size="small" variant="primary" onClick={() => void act(() => api.tidyUp(plan.id, true), `Tidying up ${tasks.length === 1 ? '1 worktree' : `${tasks.length} worktrees`}`)}>
        Tidy Up
      </Button>
    </div>
  );
}

