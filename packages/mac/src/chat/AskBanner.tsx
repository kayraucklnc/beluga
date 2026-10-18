import { Icon } from '../components/Icon.js';
import { Button, Tip } from '../components/ui.js';
import { openSheet } from '../lib/sheets.js';
import s from './ask.module.css';

const HINT = 'A worktree from the latest origin, with this conversation; Claude goes on there';

/** "Continue in New Worktree…": the way out of a questions-only chat (opens its sheet). */
export function ContinueButton({ wsId, className, variant = 'primary' }: { wsId: string; className?: string; variant?: 'primary' | 'plain' }) {
  return (
    <Tip label={HINT}>
      <Button variant={variant} icon="branch" className={className} onClick={() => openSheet({ kind: 'continue_worktree', wsId })}>
        Continue in New Worktree…
      </Button>
    </Tip>
  );
}

/**
 * Above the message box of a chat in a project's main folder: it's for questions, and the
 * button moves the conversation somewhere Claude can work. (Asking Claude for a change there
 * moves it too.)
 */
export function AskBanner({ wsId }: { wsId: string }) {
  return (
    <div className={s.wrap}>
      <div className={s.banner} role="note" aria-label="Questions only">
        <Icon name="eye" size={13} className={s.icon} />
        <span className={s.text}>
          <span className={s.lead}>Questions only</span> — Claude won’t change anything in main. Ask for a change and it moves to a new worktree.
        </span>
        <ContinueButton wsId={wsId} variant="plain" className={s.button} />
      </div>
    </div>
  );
}
