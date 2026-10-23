import { Button } from '../components/ui.js';
import { lastCheckedLabel, modeOf, statusLine, switchesOf } from '../lib/update-model.js';
import { checkForUpdates, openUpdateSheet, setUpdateMode, useUpdates } from '../lib/updates.js';
import { Group, Row, Switch } from './settings-controls.js';

const AUTO_DETAIL = {
  on: 'Downloads new versions in the background and installs once you step away and nothing is running. Beluga reopens without taking focus.',
  off: 'Downloads in the background, then shows “Beluga is ready” in the sidebar. Otherwise it installs the next time you quit.',
};
const CHECK_DETAIL = {
  on: 'At launch and every few hours while Beluga runs.',
  off: 'Beluga only looks when you click Check Now.',
};

/** Check Now, and what's happening (or when Beluga last looked). */
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
  const on = switchesOf(state.mode);
  return (
    <Group title="Updates">
      <Row label="Update automatically" detail={on.auto ? AUTO_DETAIL.on : AUTO_DETAIL.off}>
        <Switch label="Update automatically" on={on.auto} onChange={(auto) => void setUpdateMode(modeOf({ auto }, state.mode))} />
      </Row>
      <Row label="Check for updates" detail={on.check ? CHECK_DETAIL.on : CHECK_DETAIL.off}>
        <Switch label="Check for updates" on={on.check} onChange={(check) => void setUpdateMode(modeOf({ check }, state.mode))} />
      </Row>
      <CheckRow label={`Beluga ${state.current}`} />
    </Group>
  );
}

/** Settings › About: the same Check Now. */
export function UpdateAboutRow() {
  return <CheckRow label="Updates" />;
}
