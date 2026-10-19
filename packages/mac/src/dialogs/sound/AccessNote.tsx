import { Button } from '../../components/ui.js';
import { Icon } from '../../components/Icon.js';
import { openNotificationSettings, useNotificationAccess } from '../../lib/sounds/access.js';
import { accessProblem } from '../../lib/sounds/access-model.js';
import { Group } from '../settings-controls.js';
import s from './sound.module.css';

/** A note at the top of Settings › Notifications when macOS has Klaud's notifications turned off. Checked again when you come back. */
export function AccessNote() {
  const access = useNotificationAccess();
  const problem = accessProblem(access);
  if (!problem) return null;
  return (
    <Group>
      <div className={s.access} role="status">
        <Icon name="alert" size={16} />
        <div className={s.accessText}>
          <div className={s.accessTitle}>{problem.title}</div>
          <div className={s.accessDetail}>{problem.detail}</div>
        </div>
        <Button onClick={() => void openNotificationSettings().catch(() => undefined)}>Open System Settings</Button>
      </div>
    </Group>
  );
}

