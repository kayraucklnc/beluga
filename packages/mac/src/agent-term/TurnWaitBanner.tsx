import { Icon } from '../components/Icon.js';
import { Button } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { stopClaude } from '../lib/commands.js';
import s from './agent-term.module.css';

/**
 * Over the chat while the terminal you picked waits for a turn in the chat to end (BLG-553): a
 * new worktree's first turn, or one you sent before switching. The terminal opens by itself when
 * the turn ends; Stop ends it now (your queued messages come back to the box, as Stop does).
 */
export function TurnWaitBanner({ wsId }: { readonly wsId: string }) {
  const { client, ui } = useBeluga();
  const actions = useActions();
  const label = useApp((st) => st.projects.flatMap((p) => p.workspaces).find((w) => w.id === wsId)?.agent?.label ?? 'Your agent');
  return (
    <div className={s.waiting} role="status" data-turn-wait="">
      <Icon name="terminal" size={14} />
      <span className={s.drivingText}>{label} is on a turn in the chat. Its terminal opens here when the turn ends.</span>
      <Button size="small" icon="stop" onClick={() => stopClaude({ client, ui, actions }, `ws:${wsId}`)}>
        Stop and Open
      </Button>
    </div>
  );
}
