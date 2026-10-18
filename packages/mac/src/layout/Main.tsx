import { Component, type ReactNode, lazy, Suspense } from 'react';
import { Button, Empty } from '../components/ui.js';
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
      // Its Files tab browses and searches (the terminal UI's read-only shell lives there too).
      return view.tab === 'chat' ? <ChatView /> : view.tab === 'diff' ? <DiffView /> : <FilesView />;
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

/** A view that breaks shows what happened and a way back, instead of blanking the window. */
class ViewBoundary extends Component<{ children: ReactNode; at: string }, { error?: Error }> {
  override state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }
  override componentDidUpdate(prev: { at: string }): void {
    // Going somewhere else tries again.
    if (prev.at !== this.props.at && this.state.error) this.setState({ error: undefined });
  }
  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <Empty
        icon="alert"
        title="This view ran into a problem"
        detail={this.state.error.message}
        action={
          <Button size="small" onClick={() => this.setState({ error: undefined })}>
            Try Again
          </Button>
        }
      />
    );
  }
}

export function Main() {
  const at = useApp((st) => JSON.stringify(st.view));
  return (
    <main className={s.main}>
      <Toolbar />
      <ViewBoundary at={at}>
        <Suspense fallback={<div className={s.loading} />}>
          <Route />
        </Suspense>
      </ViewBoundary>
    </main>
  );
}
