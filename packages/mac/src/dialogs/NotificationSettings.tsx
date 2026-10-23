import type { NotifySettings } from '@beluga/shared/settings-schema.js';
import { DND_CHOICES, type DndChoice, dndActive, dndFor, dndLabel } from '@beluga/shared/quiet.js';
import { Button } from '../components/ui.js';
import { previewRequestPopup } from '../gateway/request-native.js';
import { useApi, useApp } from '../lib/beluga.js';
import { runAccessAction, useNotificationAccess } from '../lib/sounds/access.js';
import { type AccessAction, notifyStatus } from '../lib/sounds/access-model.js';
import { Group, Row, Select, Switch } from './settings-controls.js';
import { NotifyStatusLine } from './sound/NotifyStatus.js';
import { SoundSettings } from './sound/SoundSettings.js';
import { TestNotification } from './sound/TestNotification.js';

type Toggle = 'desktop' | 'onlyAway' | 'planMilestones' | 'needsYou' | 'done' | 'mentions' | 'people' | 'background' | 'problems' | 'pr';

const KINDS: ReadonlyArray<readonly [Toggle, string, string]> = [
  ['needsYou', 'Claude needs you', 'A question, a plan, or an approval'],
  ['done', 'Claude finished', 'In a conversation you’re not looking at'],
  ['mentions', 'Mentions and messages', 'Someone writes @you, or to you when it’s just the two of you'],
  ['people', 'People come and go', 'Someone joins, leaves, invites you, or hands work to you'],
  ['background', 'Background tasks', 'Something Claude runs in the background, or a new worktree’s setup, finishes'],
  ['problems', 'Problems', 'Errors, merge conflicts, failed setups'],
  ['pr', 'Pull requests', 'Opened, checks finished, reviewed'],
  ['planMilestones', 'Plans: milestones only', 'A plan tells you when a milestone passes, fails or waits for you, and when its Claude asks you something. Its tasks finishing go quietly into the bell'],
];

/**
 * Settings › Notifications: whether they reach you (and how to fix it when macOS is in the
 * way), the sound with a test right under it, and what reaches you when. Shared with the
 * terminal app.
 */
export function NotificationSettings() {
  const api = useApi();
  const n = useApp((st) => st.prefs.notify);
  const save = (patch: Partial<NotifySettings>): void => void api.session.setPrefs({ notify: { ...n, ...patch } });
  const quiet = dndActive(n);
  const { access, recheck } = useNotificationAccess();
  const status = notifyStatus(access, { desktop: n.desktop, quietUntil: quiet ? dndLabel(n) : null });
  // Opening System Settings: checked again when you come back (window focus). Asking: right away.
  const act = (action: AccessAction): void => void runAccessAction(action).then((a) => a && recheck(a)).catch(() => undefined);
  return (
    <>
      <NotifyStatusLine status={status} onAction={act} />
      <Group>
        <Row label="Desktop notifications" detail="The bell in the toolbar lists everything either way.">
          <Switch label="Desktop notifications" on={n.desktop} onChange={(v) => save({ desktop: v })} />
        </Row>
        <Row label="Show on-screen popups when something needs me" detail="A question, an approval, a decision of yours in a plan, or a milestone to pass: a card in the corner of the screen, on top of other apps, as friends’ requests get. Not on Do Not Disturb.">
          <Switch label="Show on-screen popups when something needs me" on={n.popup !== false} onChange={(v) => save({ popup: v })} />
        </Row>
        <Row label="See the pop-up" detail="A pretend friend’s request and a pretend decision, in the corner of the screen for a minute. Their buttons do nothing.">
          <Button onClick={previewRequestPopup}>Preview Pop-up</Button>
        </Row>
        <Row label="Only when Beluga isn’t in front" detail="Stay quiet while you’re using Beluga. Nothing is ever announced about the conversation you’re looking at.">
          <Switch label="Only when Beluga isn’t in front" on={n.onlyAway} onChange={(v) => save({ onlyAway: v })} />
        </Row>
      </Group>
      <SoundSettings n={n} save={save} test={<TestNotification n={n} onChecked={recheck} onAction={act} />} />
      <Group>
        <Row label="Do Not Disturb" detail={quiet ? `On ${dndLabel(n)}. The bell still fills.` : 'Pause desktop notifications for a while.'}>
          {quiet ? (
            <Button onClick={() => save({ dnd: null })}>Turn off</Button>
          ) : (
            <Select<'off' | DndChoice>
              label="Do Not Disturb"
              value="off"
              options={[{ value: 'off', label: 'Off' }, ...DND_CHOICES]}
              onChange={(v) => save({ dnd: v === 'off' ? null : dndFor(v) })}
            />
          )}
        </Row>
      </Group>
      <Group title="Tell me when">
        {KINDS.map(([key, label, detail]) => (
          <Row key={key} label={label} detail={detail}>
            <Switch label={label} on={n[key]} onChange={(v) => save({ [key]: v })} />
          </Row>
        ))}
      </Group>
    </>
  );
}
