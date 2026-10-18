import { lazy, Suspense } from 'react';
import { useApp } from '../lib/klaud.js';
import { ChatView } from '../views/ChatView.js';
import { Toolbar } from './Toolbar.js';
import s from './Shell.module.css';

const OverviewView = lazy(() => import('../views/OverviewView.js').then((m) => ({ default: m.OverviewView })));
const SearchView = lazy(() => import('../views/SearchView.js').then((m) => ({ default: m.SearchView })));
const UsageView = lazy(() => import('../views/UsageView.js').then((m) => ({ default: m.UsageView })));
const FilesView = lazy(() => import('../views/FilesView.js').then((m) => ({ default: m.FilesView })));
const DiffView = lazy(() => import('../views/DiffView.js').then((m) => ({ default: m.DiffView })));
const TerminalView = lazy(() => import('../views/TerminalView.js').then((m) => ({ default: m.TerminalView })));
const GuestShellView = lazy(() => import('../views/GuestShellView.js').then((m) => ({ default: m.GuestShellView })));

function Route() {
  const view = useApp((st) => st.view);
  switch (view.kind) {
    case 'room':
    case 'draft':
    case 'draft_worktree':
      return <ChatView />;
    case 'workspace':
      return view.tab === 'chat' ? <ChatView /> : view.tab === 'files' ? <FilesView /> : view.tab === 'review' ? <DiffView /> : <TerminalView />;
    case 'shared':
      return view.tab === 'chat' ? <ChatView /> : view.tab === 'files' ? <FilesView /> : view.tab === 'diff' ? <DiffView /> : <GuestShellView />;
    case 'overview':
      return <OverviewView />;
    case 'search':
      return <SearchView />;
    case 'usage':
      return <UsageView />;
    case 'files':
      return <FilesView />;
    case 'terminal':
      return <TerminalView />;
  }
}

export function Main() {
  return (
    <main className={s.main}>
      <Toolbar />
      <Suspense fallback={<div className={s.loading} />}>
        <Route />
      </Suspense>
    </main>
  );
}
