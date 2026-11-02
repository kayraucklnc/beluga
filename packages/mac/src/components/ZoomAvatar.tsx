import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { useAvatarUrl } from '../lib/avatars.js';
import { Avatar } from './ui.js';
import s from './zoom-avatar.module.css';

/**
 * Someone's avatar on their profile card: with a picture, a click opens it large over the window
 * (Esc or a click anywhere closes it); with just their initial it's a plain avatar.
 */
export function ZoomAvatar({ name, id, size = 56 }: { name: string; id: string; size?: number }) {
  const picture = useAvatarUrl(id);
  const [open, setOpen] = useState(false);
  if (!picture) return <Avatar name={name} id={id} size={size} />;
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className={s.trigger} onClick={(e) => e.stopPropagation()} style={{ width: size, height: size }} aria-label={`See ${name}’s picture`}>
          <Avatar name={name} id={id} size={size} />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content
          className={s.stage}
          aria-describedby={undefined}
          onClick={(e) => {
            // Not on to the card or row it was opened from (React passes portal clicks up its tree).
            e.stopPropagation();
            setOpen(false);
          }}
        >
          <Dialog.Title className="visually-hidden">{name}’s picture</Dialog.Title>
          <img className={s.picture} src={picture} alt={name} draggable={false} />
          <div className={s.caption}>{name}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
