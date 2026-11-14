import { type ReactElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { shownBody } from '@beluga/core/plans/model.js';
import { cx } from '../components/ui.js';
import { ResizeHandle } from '../layout/panel/ResizeHandle.js';
import { PLAN_CHAT_TOGGLE } from '../lib/panel.js';
import { OPEN_DECISION } from './plan-ask-model.js';
import { PlanChat } from './PlanChat.js';
import { PlanStage, setPlanLayout, usePlanLayout } from './PlanStage.js';
import { CHAT_DEFAULT, chatOpen, clampChatWidth, setChatOpen } from './plan-layout.js';
import { usePlans } from './use-plans.js';
import p from './plans.module.css';

/**
 * A plan's page: its stage (what it is, the one thing it waits for, the plan as a living graph or an
 * outline), and the conversation with Claude beside it, where the plan is talked through and changed.
 */
export function PlanPage({ id, task }: { id: string; task?: string }) {
  const plan = usePlans().plans.find((x) => x.id === id);
  const layout = usePlanLayout();
  const open = chatOpen(layout, id);
  const show = useCallback((next: boolean) => setPlanLayout((l) => setChatOpen(l, id, next)), [id]);
  const chat = useMemo(() => ({ open, show }), [open, show]);
  // ⌥⌘0 (and View › Show Panel): on a plan's page its right side is the chat.
  useEffect(() => {
    const toggle = (): void => setPlanLayout((l) => setChatOpen(l, id, !chatOpen(l, id)));
    document.addEventListener(PLAN_CHAT_TOGGLE, toggle);
    return () => document.removeEventListener(PLAN_CHAT_TOGGLE, toggle);
  }, [id]);
  // Decide… on a task of yours (the outline, its details): the conversation, where its card is.
  useEffect(() => {
    const decide = (): void => show(true);
    document.addEventListener(OPEN_DECISION, decide);
    return () => document.removeEventListener(OPEN_DECISION, decide);
  }, [show]);
  const home = plan?.home;
  const draft = !plan?.body || Boolean(plan?.draft);
  const drafting = !plan?.body && !(plan && shownBody(plan))?.milestones.length;
  const beside = useCallback(
    (stage: ReactElement) => (
      <ChatSplit open={open} chatWidth={layout.chatWidth} stage={stage}>
        {home ? <PlanChat channel={home} draft={draft} drafting={drafting} project={plan!.projectId} onClose={() => show(false)} /> : null}
      </ChatSplit>
    ),
    [open, layout.chatWidth, home, draft, drafting, plan, show],
  );
  return <PlanStage planId={id} {...(task ? { task } : {})} chat={chat} beside={beside} />;
}

/** The stage and, beside it, the chat: dragged (live), else the width you left it at, never past half the plan's area. */
function ChatSplit({ open, chatWidth: saved, stage, children }: { open: boolean; chatWidth: number; stage: ReactElement; children: ReactElement | null }) {
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
  const chatWidth = drag ?? clampChatWidth(saved, areaWidth || window.innerWidth);
  return (
    <div ref={split} className={cx(p.split, open && p.splitChat)} style={open ? { gridTemplateColumns: `minmax(0, 1fr) ${chatWidth}px` } : undefined}>
      {stage}
      {/* Hidden, not gone: what you typed, where you'd scrolled and a send to retry are there when it's back. */}
      {children ? (
        <div className={p.chatSide} style={open ? undefined : { display: 'none' }} aria-hidden={open ? undefined : true}>
          <ResizeHandle
            axis="x"
            label="Resize the chat"
            className={p.chatEdge}
            onMove={(x) => setDrag(clampChatWidth((split.current?.getBoundingClientRect().right ?? window.innerWidth) - x, splitWidth()))}
            onEnd={() => {
              if (drag !== undefined) setPlanLayout((l) => ({ ...l, chatWidth: drag }));
              setDrag(undefined);
            }}
            onReset={() => setPlanLayout((l) => ({ ...l, chatWidth: CHAT_DEFAULT }))}
            onStep={(dir) => setPlanLayout((l) => ({ ...l, chatWidth: clampChatWidth(chatWidth + dir * 24, splitWidth()) }))}
          />
          {children}
        </div>
      ) : null}
    </div>
  );
}
