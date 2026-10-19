import { pillOf } from '../lib/update-model.js';
import { openUpdateSheet, useUpdates } from '../lib/updates.js';
import { cx } from './ui.js';
import s from './update.module.css';

/**
 * "Klaud 0.5 is ready": a small pill at the bottom of the sidebar once an update has
 * downloaded (or, after one installed, "What's new"). Clicking it opens the update sheet.
 * Nothing at all the rest of the time. `floating`: no sidebar to sit in, so a corner.
 */
export function UpdatePill({ floating = false }: { floating?: boolean }) {
  const { state } = useUpdates();
  const pill = pillOf(state);
  if (!pill) return null;
  const idle = pill.kind === 'ready' && state.choice === 'idle' && state.phase !== 'installing';
  return (
    <button type="button" className={cx(s.pill, pill.kind === 'news' && s.news, floating && s.floating)} onClick={openUpdateSheet} data-update-pill={pill.kind} title={idle ? 'Installs when you step away' : undefined}>
      <span className={s.dot} aria-hidden />
      <span className={s.label}>{pill.label}</span>
      {idle ? <span className={s.hint}>when idle</span> : null}
    </button>
  );
}
