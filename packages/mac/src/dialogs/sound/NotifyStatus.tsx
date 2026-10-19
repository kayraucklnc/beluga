import { Icon, type IconName } from '../../components/Icon.js';
import { Button, cx } from '../../components/ui.js';
import { ACTION_LABELS, type AccessAction, type NotifyStatus } from '../../lib/sounds/access-model.js';
import { Group } from '../settings-controls.js';
import s from './sound.module.css';

const ICONS: Readonly<Record<NotifyStatus['tone'], IconName>> = { ok: 'check', warn: 'alert', muted: 'info' };

export interface NotifyStatusProps {
  readonly status: NotifyStatus;
  readonly onAction: (action: AccessAction) => void;
}

/**
 * The top of Settings › Notifications: whether your banners reach you ("Notifications are on",
 * "Blocked by macOS", "Send a test to check"…), and when something's in the way, what to turn on and
 * a button that goes there. It updates when you come back from System Settings.
 */
export function NotifyStatusLine({ status, onAction }: NotifyStatusProps) {
  const { tone, title, detail, fix, action } = status;
  return (
    <Group>
      <div className={cx(s.status, s[`status_${tone}`])} role="status" aria-label="Notification status" data-tone={tone}>
        <Icon name={ICONS[tone]} size={16} />
        <div className={s.statusText}>
          <div className={s.statusTitle}>{title}</div>
          <div className={s.statusDetail}>{detail}</div>
          {fix ? <div className={s.statusFix}>{fix}</div> : null}
        </div>
        {action ? (
          <Button variant="primary" onClick={() => onAction(action)}>
            {ACTION_LABELS[action]}
          </Button>
        ) : null}
      </div>
    </Group>
  );
}
