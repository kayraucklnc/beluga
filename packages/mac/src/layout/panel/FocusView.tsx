import { lazy, Suspense, useEffect } from 'react';
import { shareNameOf } from '@klaud/shared/share-names.js';
import { Icon } from '../../components/Icon.js';
import { Kbd } from '../../components/ui.js';
import { useApp } from '../../lib/klaud.js';
import { type FocusKind, closeFocus, usePanelRuntime } from '../../lib/panel.js';
import { ChatView } from '../../views/ChatView.js';
import s from './panel.module.css';

const DiffView = lazy(() => import('../../views/DiffView.js').then((m) => ({ default: m.DiffView })));
const Viewer = lazy(() => import('../../views/FilesView.js').then((m) => ({ default: m.Viewer })));
const TerminalView = lazy(() => import('../../views/TerminalView.js').then((m) => ({ default: m.TerminalView })));

const TITLES: Record<FocusKind, string> = { diff: 'Changes', file: 'File', terminal: 'Terminal' };

/** Escape goes back to the chat, unless it's closing something else first (a menu, a field, the terminal's own use). */
function useEscapeBack(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t?.closest('.xterm, input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) return;
      if (document.querySelector('[data-radix-popper-content-wrapper], [role="dialog"]')) return;
      e.preventDefault();
      closeFocus();
    };
    window.addEventListener('keydown', onKey);
    // Something put text in the message box (Mention in Chat, Ask Claude): the chat is where it
    // goes. The box wasn't on screen to take the keyboard, so ask again once it is.
    const back = (): void => {
      closeFocus();
      setTimeout(() => document.dispatchEvent(new CustomEvent('klaud:focus-composer')), 40);
    };
    document.addEventListener('klaud:focus-composer', back);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('klaud:focus-composer', back);
    };
  }, []);
}

/** A diff, a file or the terminal across the whole center for a while; the chat is one click (or Esc) away. */
function FocusView({ kind, wsId }: { kind: FocusKind; wsId: string }) {
  useEscapeBack();
  const viewer = useApp((st) => (st.viewer && st.viewer.owner === st.selfId && st.viewer.share === shareNameOf(wsId) ? st.viewer : undefined));
  const path = useApp((st) => (kind === 'diff' ? st.review?.data?.files[st.review.selected]?.path : kind === 'file' ? viewer?.path : undefined));
  // The file was closed: nothing left to focus on.
  useEffect(() => {
    if (kind === 'file' && !viewer) closeFocus();
  }, [kind, viewer]);
  return (
    <div className={s.focus}>
      <div className={s.focusBar}>
        <button type="button" className={s.back} onClick={closeFocus} aria-label="Back to Chat">
          <Icon name="back" size={12} />
          Back to Chat
          <Kbd>Esc</Kbd>
        </button>
        <span className={s.focusTitle}>
          {TITLES[kind]}
          {path ? <span className={s.focusPath}>{path}</span> : null}
        </span>
      </div>
      <Suspense fallback={<div className={s.loading} />}>
        <div className={s.focusBody}>{kind === 'diff' ? <DiffView /> : kind === 'terminal' ? <TerminalView /> : viewer ? <Viewer viewer={viewer} /> : null}</div>
      </Suspense>
    </div>
  );
}

/** A workspace's center: its conversation, or for a while a diff, a file or its terminal in full. */
export function WorkspaceCenter() {
  const view = useApp((st) => st.view);
  const wsId = view.kind === 'workspace' ? view.id : undefined;
  const focus = usePanelRuntime((r) => (wsId && r.focus?.wsId === wsId ? r.focus.kind : undefined));
  return focus && wsId ? <FocusView kind={focus} wsId={wsId} /> : <ChatView />;
}
