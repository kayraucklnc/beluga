import { useState } from 'react';
import { Button } from '../components/ui.js';
import { useKlaud } from '../lib/klaud.js';
import { Group, Row, Switch } from '../dialogs/settings-controls.js';
import { openNet } from './net-sheets.js';
import { errorText, quietly, useNetwork } from './use-net.js';

/** Settings › People & access: talking with friends directly (the klaud network), on or off. */
export function NetworkSettings() {
  const { client, ui } = useKlaud();
  const net = useNetwork();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const turn = async (on: boolean): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await quietly(client, client.api.network.setEnabled(on));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const friends = net.friends.length;
  const groups = net.groups.filter((g) => g.active).length;
  return (
    <Group title="Friends">
      <Row
        label="Talk with friends directly"
        detail={
          error ? (
            <span style={{ color: 'var(--error)' }}>{error}</span>
          ) : busy ? (
            'Turning it on…'
          ) : net.enabled ? (
            `Your Mac connects straight to your friends’ Macs, end-to-end encrypted. ${friends} friend${friends === 1 ? '' : 's'}, ${groups} group${groups === 1 ? '' : 's'}.`
          ) : (
            'Messages and groups go from Mac to Mac, end-to-end encrypted. No server, no account.'
          )
        }
      >
        <Switch label="Talk with friends directly" on={net.enabled || busy} onChange={(v) => void turn(v)} />
      </Row>
      {net.enabled ? (
        <Row label="Add a friend" detail="Send them a code or a link; they’re your friend once they use it.">
          <Button
            onClick={() => {
              ui.patch({ settings: undefined });
              openNet({ kind: 'add_friend' });
            }}
          >
            Add a Friend…
          </Button>
        </Row>
      ) : null}
    </Group>
  );
}
