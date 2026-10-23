import { useState } from 'react';
import type { NotifySettings } from '../../../../../src/shared/settings-schema.js';
import { soundFor, volumeOf } from '../../../../../src/shared/notify-sound.js';
import { Icon } from '../../components/Icon.js';
import { Button, cx } from '../../components/ui.js';
import { useApi } from '../../lib/beluga.js';
import { notificationAccess } from '../../lib/sounds/access.js';
import { ACTION_LABELS, type AccessAction, type NotificationAccess, type TestOutcome, testOutcome } from '../../lib/sounds/access-model.js';
import { soundTitle } from '../../lib/sounds/catalog.js';
import { playTestSound } from '../../lib/sounds/native.js';
import { Row } from '../settings-controls.js';
import s from './sound.module.css';

export interface TestNotificationProps {
  readonly n: NotifySettings;
  /** What macOS said after the test (the status line above updates with it). */
  readonly onChecked: (access: NotificationAccess) => void;
  readonly onAction: (action: AccessAction) => void;
}

/**
 * Send Test Notification, right under the sound: plays the sound here at once (heard even when
 * macOS holds the banner), sends the banner, and then says what really happened, with the button
 * that fixes it when something's in the way.
 */
export function TestNotification({ n, onChecked, onAction }: TestNotificationProps) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<TestOutcome>();
  // The test is a "Claude finished" notification (core/notify.ts Notifier.test).
  const tone = soundFor(n, 'done');

  const send = async (): Promise<void> => {
    setBusy(true);
    setOutcome(undefined);
    playTestSound({ sound: tone.kind !== 'none', tone, volume: volumeOf(n) }, true);
    try {
      const access = await notificationAccess();
      await api.session.testNotification();
      onChecked(access);
      setOutcome(testOutcome(access, tone.kind === 'none' ? null : soundTitle(tone)));
    } catch (e) {
      setOutcome({ tone: 'warn', text: `Couldn’t send it: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Row label="Test notification" detail="Plays your sound here and shows a banner, whatever your other settings say.">
        <Button icon="bell" disabled={busy} onClick={() => void send()}>
          {busy ? 'Sending…' : 'Send Test Notification'}
        </Button>
      </Row>
      {outcome ? (
        <div className={cx(s.outcome, s[`outcome_${outcome.tone}`])} role="status" aria-label="Test result">
          <Icon name={outcome.tone === 'ok' ? 'check' : 'alert'} size={14} />
          <span className={s.outcomeText}>{outcome.text}</span>
          {outcome.action ? (
            <Button size="small" onClick={() => onAction(outcome.action!)}>
              {ACTION_LABELS[outcome.action]}
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
