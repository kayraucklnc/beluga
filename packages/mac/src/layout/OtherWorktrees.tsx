import type { Project } from '@klaud/workspaces/types.js';
import { Icon } from '../components/Icon.js';
import { useActions } from '../lib/actions.js';
import { useApp, useUi } from '../lib/klaud.js';
import { useOtherActivity } from '../views/worktree-info-state.js';
import { orderOutside, outsideActivity, outsideOf, visibleOutside } from './outside-model.js';
import { Row } from './sidebar-parts.js';
import { WorkspaceRow } from './workspace-row.js';
import { SubAgentRows } from './SubAgents.js';
import { isAgentWorktree } from '../claude-code/subagents-model.js';
import { Fragment } from 'react';
import o from './other-worktrees.module.css';

/**
 * A project's worktrees made outside Klaud, listed after Klaud's own as ordinary rows: each
 * with its name and, quietly, where it is; most recently active first. With many, the most
 * recent few show, then "Show N more". Cleaning them up is on the Worktrees page.
 */
export function OutsideWorktrees({ p, indent }: { p: Project; indent: number }) {
  const actions = useActions();
  const log = useApp((st) => st.log);
  const here = useApp((st) => (st.view.kind === 'workspace' ? st.view.id : undefined));
  const key = `outside-more:${p.id}`;
  const expanded = useUi((u) => u.collapsed.includes(key));
  // Sub-agents' own worktrees aren't yours: they show as the agent (see SubAgents.tsx).
  const list = outsideOf(p).filter((w) => !isAgentWorktree(w));
  const activity = useOtherActivity(
    p.id,
    list.map((w) => w.id),
  );
  if (!list.length) return null;
  const ordered = orderOutside(list, (w) => outsideActivity({ log }, w, activity));
  // What "Show N more" tucks away (it stays as "Show Fewer" once expanded).
  const { hidden } = visibleOutside(ordered, false, here);
  const { shown } = visibleOutside(ordered, expanded, here);
  const toggle = (): void => actions.run({ type: 'toggle_fold', key });
  return (
    <>
      {shown.map((w) => (
        <Fragment key={w.id}>
          <WorkspaceRow ws={w} indent={indent} />
          <SubAgentRows ws={w} indent={indent + 1} />
        </Fragment>
      ))}
      {hidden.length ? (
        <Row
          indent={indent}
          className={o.more}
          aria-expanded={expanded}
          icon={<Icon name={expanded ? 'chevronUp' : 'chevronDown'} size={10} />}
          label={expanded ? 'Show Fewer' : `Show ${hidden.length} more`}
          detail={expanded ? 'Show only the most recent worktrees made outside Klaud' : `${hidden.length} more worktree${hidden.length === 1 ? '' : 's'} made outside Klaud, less recently active`}
          onClick={toggle}
        />
      ) : null}
    </>
  );
}
