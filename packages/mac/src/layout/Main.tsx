import { Component, type ReactNode, lazy, Suspense, useRef } from 'react';
import { Button, Empty } from '../components/ui.js';
import { useApp } from '../lib/klaud.js';
import { ChatView } from '../views/ChatView.js';
import { Toolbar } from './Toolbar.js';
import { WorkspaceCenter } from './panel/FocusView.js';
import { TerminalDrawer } from './panel/TerminalDrawer.js';
import s from './Shell.module.css';

const OverviewView = lazy(() => import('../views/OverviewView.js').then((m) => ({ default: m.OverviewView })));
const SearchView = lazy(() => import('../views/SearchView.js').then((m) => ({ default: m.SearchView })));
const UsageView = lazy(() => import('../views/UsageView.js').then((m) => ({ default: m.UsageView })));
const FilesView = lazy(() => import('../views/FilesView.js').then((m) => ({ default: m.FilesView })));
const DiffView = lazy(() => import('../views/DiffView.js').then((m) => ({ default: m.DiffView })));
const ConversationView = lazy(() => import('../network/ConversationView.js').then((m) => ({ default: m.ConversationView })));
const TerminalView = lazy(() => import('../views/TerminalView.js').then((m) => ({ default: m.TerminalView })));
const ActivityView = lazy(() => import('../claude-code/ActivityView.js').then((m) => ({ default: m.ActivityView })));
const ProjectHome = lazy(() => import('../views/ProjectHome.js').then((m) => ({ default: m.ProjectHome })));
const HistoryView = lazy(() => import('../views/history/HistoryView.js').then((m) => ({ default: m.HistoryView })));
const RequestsView = lazy(() => import('../gateway/RequestsView.js').then((m) => ({ default: m.RequestsView })));
const TasksView = lazy(() => import('../tasks/TasksView.js').then((m) => ({ default: m.TasksView })));
const TaskPage = lazy(() => import('../tasks/TaskPage.js').then((m) => ({ default: m.TaskPage })));

function Route() {
  const view = useApp((st) => st.view);
  switch (view.kind) {
    case 'room':
    case 'draft':
    case 'draft_worktree':
      return <ChatView />;
    case 'workspace':
      // Always the conversation; its changes, files and terminal are in the right panel (a diff or a file can take the center for a while).
      return <WorkspaceCenter />;
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
    case 'conversation':
      return <ConversationView id={view.id} />;
    case 'claude_code':
      return <ActivityView />;
    case 'requests':
      return <RequestsView />;
    case 'tasks':
      return <TasksView />;
    case 'task':
      return <TaskPage key={view.id} id={view.id} />;
    case 'project':
      return view.page === 'history' ? <HistoryView projectId={view.id} /> : <ProjectHome id={view.id} />;
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
  const column = useRef<HTMLElement>(null);
  return (
    <main ref={column} className={s.main}>
      <Toolbar />
      <ViewBoundary at={at}>
        <Suspense fallback={<div className={s.loading} />}>
          <Route />
        </Suspense>
      </ViewBoundary>
      <TerminalDrawer column={column} />
    </main>
  );
}
