import { lazy, Suspense, useEffect } from 'react';
import { shareNameOf } from '@beluga/shared/share-names.js';
import { Icon } from '../../components/Icon.js';
import { Kbd } from '../../components/ui.js';
import { useApp } from '../../lib/beluga.js';
import { type FocusKind, closeFocus, usePanelRuntime } from '../../lib/panel.js';
import { ChatView } from '../../views/ChatView.js';
import s from './panel.module.css';

const DiffView = lazy(() => import('../../views/DiffView.js').then((m) => ({ default: m.DiffView })));
const FileFocus = lazy(() => import('../../views/reader/FileFocus.js').then((m) => ({ default: m.FileFocus })));
const PrPage = lazy(() => import('../../pr/PrPage.js').then((m) => ({ default: m.PrPage })));
const TerminalView = lazy(() => import('../../views/TerminalView.js').then((m) => ({ default: m.TerminalView })));

const TITLES: Record<FocusKind, string> = { diff: 'Changes', file: 'File', terminal: 'Terminal', pr: 'Pull Request' };

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
      setTimeout(() => document.dispatchEvent(new CustomEvent('beluga:focus-composer')), 40);
    };
    document.addEventListener('beluga:focus-composer', back);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('beluga:focus-composer', back);
    };
  }, []);
}

/** A diff, a file or the terminal across the whole center for a while; the chat is one click (or Esc) away. */
function FocusView({ kind, wsId }: { kind: FocusKind; wsId: string }) {
  useEscapeBack();
  const viewer = useApp((st) => (st.viewer && st.viewer.owner === st.selfId && st.viewer.share === shareNameOf(wsId) ? st.viewer : undefined));
  const path = useApp((st) => (kind === 'diff' ? st.review?.data?.files[st.review.selected]?.path : undefined));
  // The file was closed: nothing left to focus on.
  useEffect(() => {
    if (kind === 'file' && !viewer) closeFocus();
  }, [kind, viewer]);
  // A file brings its own header (where it is, Rendered / Source, Copy, Open in Editor…).
  if (kind === 'file') {
    return viewer ? (
      <Suspense fallback={<div className={s.loading} />}>
        <FileFocus viewer={viewer} wsId={wsId} />
      </Suspense>
    ) : null;
  }
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
        <div className={s.focusBody}>{kind === 'diff' ? <DiffView /> : kind === 'pr' ? <PrPage wsId={wsId} /> : <TerminalView />}</div>
      </Suspense>
    </div>
  );
}

/** A workspace's center: its conversation, or for a while a diff, a file, its terminal or its PR in full. */
export function WorkspaceCenter() {
  const view = useApp((st) => st.view);
  const wsId = view.kind === 'workspace' ? view.id : undefined;
  const focus = usePanelRuntime((r) => (wsId && r.focus?.wsId === wsId ? r.focus.kind : undefined));
  return focus && wsId ? <FocusView kind={focus} wsId={wsId} /> : <ChatView />;
}
