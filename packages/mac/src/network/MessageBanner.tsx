import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { Avatar } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { brandText } from '../lib/brand.js';
import { MESSAGE_BANNER, type MessageBannerDetail, NOTIFICATION_TAP } from '../lib/notices.js';
import { GroupAvatar } from './Avatars.js';
import s from './network.module.css';

/** How long a banner stays (hovering keeps it). */
const BANNER_MS = 6000;

/**
 * A friend wrote while you're in Beluga looking at something else: macOS doesn't show banners of
 * the app in front, so the window shows one at its top right (the ding comes with it, lib/boot.ts).
 * Clicking it opens the conversation.
 */
export function MessageBanner() {
  const [banner, setBanner] = useState<(MessageBannerDetail & { id: number }) | undefined>();
  const [hover, setHover] = useState(false);
  const network = useApp((st) => st.network);
  useEffect(() => {
    let id = 0;
    const on = (e: Event): void => setBanner({ ...(e as CustomEvent<MessageBannerDetail>).detail, id: ++id });
    document.addEventListener(MESSAGE_BANNER, on);
    return () => document.removeEventListener(MESSAGE_BANNER, on);
  }, []);
  useEffect(() => {
    if (!banner || hover) return;
    const t = setTimeout(() => setBanner(undefined), BANNER_MS);
    return () => clearTimeout(t);
  }, [banner, hover]);
  if (!banner) return null;
  const { channel } = banner;
  const friend = channel?.startsWith('dm:') ? network.friends.find((f) => `dm:${f.peerId}` === channel) : undefined;
  const group = channel?.startsWith('group:') ? network.groups.find((g) => `group:${g.id}` === channel) : undefined;
  const open = (): void => {
    document.dispatchEvent(new CustomEvent(NOTIFICATION_TAP, { detail: { channel } }));
    setBanner(undefined);
  };
  return (
    <div className={s.banners} role="status" aria-live="polite">
      <div key={banner.id} className={s.banner} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        <button type="button" className={s.bannerOpen} onClick={open}>
          {friend ? <Avatar name={friend.name} id={friend.peerId} size={30} /> : group ? <GroupAvatar name={group.name} id={group.id} size={30} /> : <Icon name="chat" size={18} />}
          <span className={s.bannerText}>
            <span className={s.bannerTitle}>{brandText(banner.title)}</span>
            {banner.body ? <span className={s.bannerBody}>{brandText(banner.body)}</span> : null}
          </span>
        </button>
        <button type="button" className={s.bannerClose} aria-label="Dismiss" onClick={() => setBanner(undefined)}>
          <Icon name="x" size={11} />
        </button>
      </div>
    </div>
  );
}
