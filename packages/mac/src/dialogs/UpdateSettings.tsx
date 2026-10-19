import { Button } from '../components/ui.js';
import { lastCheckedLabel, statusLine, type UpdateMode } from '../lib/update-model.js';
import { checkForUpdates, openUpdateSheet, setUpdateMode, useUpdates } from '../lib/updates.js';
import { Group, Row, Select } from './settings-controls.js';

const MODE_DETAIL: Record<UpdateMode, string> = {
  idle: 'Downloads in the background and installs once you step away and nothing is running. Klaud reopens without taking focus.',
  ask: 'Downloads in the background, then asks. Otherwise it installs the next time you quit.',
  off: 'Klaud only looks when you click Check Now.',
};

/** Check Now, and what's happening (or when Klaud last looked). */
function CheckRow({ label }: { label: string }) {
  const { state } = useUpdates();
  const busy = state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'installing';
  const status = statusLine(state);
  return (
    <Row label={label} detail={`${status ? `${status} · ` : ''}Last checked: ${lastCheckedLabel(state.lastCheck)}`}>
      {state.available ? (
        <Button size="small" onClick={openUpdateSheet}>
          Show Update…
        </Button>
      ) : null}
      <Button size="small" onClick={() => void checkForUpdates()} disabled={busy}>
        Check Now
      </Button>
    </Row>
  );
}

/** Settings › General › Updates. */
export function UpdateSettingsGroup() {
  const { state } = useUpdates();
  return (
    <Group title="Updates">
      <Row label="Install updates" detail={MODE_DETAIL[state.mode]}>
        <Select<UpdateMode>
          label="Install updates"
          value={state.mode}
          onChange={(v) => void setUpdateMode(v)}
          options={[
            { value: 'idle', label: 'Automatically when idle' },
            { value: 'ask', label: 'Ask me' },
            { value: 'off', label: 'Off' },
          ]}
        />
      </Row>
      <CheckRow label={`Klaud ${state.current}`} />
    </Group>
  );
}

/** Settings › About: the same Check Now. */
export function UpdateAboutRow() {
  return <CheckRow label="Updates" />;
}
