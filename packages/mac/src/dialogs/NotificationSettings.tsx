import type { NotifySettings } from '@klaud/shared/settings-schema.js';
import { DND_CHOICES, type DndChoice, dndActive, dndFor, dndLabel } from '@klaud/shared/quiet.js';
import { Button } from '../components/ui.js';
import { useApi, useApp } from '../lib/klaud.js';
import { Group, Row, Select, Switch } from './settings-controls.js';
import { AccessNote } from './sound/AccessNote.js';
import { SoundSettings } from './sound/SoundSettings.js';

type Toggle = 'desktop' | 'onlyAway' | 'needsYou' | 'done' | 'mentions' | 'people' | 'background' | 'problems' | 'pr';

const KINDS: ReadonlyArray<readonly [Toggle, string, string]> = [
  ['needsYou', 'Claude needs you', 'A question, a plan, or an approval'],
  ['done', 'Claude finished', 'In a conversation you’re not looking at'],
  ['mentions', 'Mentions and messages', 'Someone writes @you, or to you when it’s just the two of you'],
  ['people', 'People come and go', 'Someone joins, leaves, invites you, or hands work to you'],
  ['background', 'Background tasks', 'Something Claude runs in the background, or a new worktree’s setup, finishes'],
  ['problems', 'Problems', 'Errors, merge conflicts, failed setups'],
  ['pr', 'Pull requests', 'Opened, checks finished, reviewed'],
];

/** Settings › Notifications: what reaches you, how, and when klaud stays quiet. Shared with the terminal app. */
export function NotificationSettings() {
  const api = useApi();
  const n = useApp((st) => st.prefs.notify);
  const save = (patch: Partial<NotifySettings>): void => void api.session.setPrefs({ notify: { ...n, ...patch } });
  const quiet = dndActive(n);
  return (
    <>
      <AccessNote />
      <Group>
        <Row label="Desktop notifications" detail="The bell in the toolbar lists everything either way.">
          <Switch label="Desktop notifications" on={n.desktop} onChange={(v) => save({ desktop: v })} />
        </Row>
        <Row label="Only when Klaud isn’t in front" detail="Stay quiet while you’re using Klaud. Nothing is ever announced about the conversation you’re looking at.">
          <Switch label="Only when Klaud isn’t in front" on={n.onlyAway} onChange={(v) => save({ onlyAway: v })} />
        </Row>
      </Group>
      <SoundSettings n={n} save={save} />
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
      <Group>
        <Row label="Send a test notification" detail="Shows one now, whatever the settings above say.">
          <Button onClick={() => void api.session.testNotification()}>Send a test</Button>
        </Row>
      </Group>
    </>
  );
}
