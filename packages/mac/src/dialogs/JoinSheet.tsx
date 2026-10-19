import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../components/ui.js';
import { useApp } from '../lib/klaud.js';
import s from './sheet.module.css';

/** Someone sent you a klaud:// link: join their room (and leave the one you're in)? */
export function JoinSheet({ invite, onJoin, onCancel }: { invite: string; onJoin: () => void; onCancel: () => void }) {
  const room = useApp((st) => st.room);
  const others = useApp((st) => st.peers.length - 1);
  const host = (() => {
    try {
      return new URL(invite.replace(/^p2p:/, 'http:')).host || 'a friend';
    } catch {
      return 'a friend';
    }
  })();
  return (
    <Dialog.Root open onOpenChange={(v) => (v ? undefined : onCancel())}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.sheet} aria-describedby={undefined}>
          <div className={s.head}>
            <Dialog.Title className={s.title}>Join {host === 'a friend' ? 'their room' : `the room at ${host}`}?</Dialog.Title>
          </div>
          <div className={s.intro}>
            <p>You'll leave {room}{others > 0 ? ` and the ${others} ${others === 1 ? 'person' : 'people'} in it` : ''}. Your projects, chats and worktrees stay on this Mac.</p>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '8px 16px 16px' }}>
            <Button variant="quiet" onClick={onCancel}>
              Stay here
            </Button>
            <Button variant="primary" onClick={onJoin} autoFocus>
              Join
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
