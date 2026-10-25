import { Icon } from '../components/Icon.js';
import { Kbd, Tip, cx } from '../components/ui.js';
import { accelLabel } from '../lib/dictation-model.js';
import { cancelDictation, dictatingInto, errorIn, finishDictation, gettingLine, toggleDictation, useDictation } from '../lib/dictation.js';
import { usePrefs } from '../lib/prefs.js';
import { mod } from '../lib/system.js';
import { useClock } from '../lib/window-active.js';
import s from './dictation.module.css';

/**
 * The composer's microphone (BLG-145): beside Send; tap to talk, tap again (or ↩) to write it in.
 * While it listens, a quiet strip over the box shows your voice's level, the time, and the keys.
 */

export function MicButton({ box }: { readonly box: React.RefObject<HTMLTextAreaElement | null> }) {
  const d = useDictation();
  const prefs = usePrefs();
  const here = dictatingInto(box.current);
  const listening = here && d.kind === 'listening';
  const busy = here && (d.kind === 'getting' || d.kind === 'writing');
  const keys = prefs.voiceShortcut ? accelLabel(prefs.voiceShortcut) : undefined;
  return (
    <Tip label={listening ? 'Write it in · esc throws it away' : busy ? (d.kind === 'writing' ? 'Writing it down…' : 'Getting ready… click to stop') : `Speak instead of typing${keys ? ` · hold ${keys} to talk` : ''}`} {...(listening ? { keys: '↩' } : keys ? { keys } : {})}>
      <button
        type="button"
        className={cx(s.mic, listening && s.micOn, busy && s.micBusy)}
        aria-label={listening ? 'Write it in' : 'Speak instead of typing'}
        aria-pressed={listening}
        disabled={d.kind === 'writing' || (d.kind !== 'off' && !here)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => toggleDictation(box.current)}
      >
        {busy ? <span className={s.spinner} /> : listening ? <span className={s.stopMark} /> : <Icon name="mic" size={14} />}
      </button>
    </Tip>
  );
}

/** Over the box while it listens or writes: your voice's level, how long, and what the keys do. */
export function DictationStrip({ box }: { readonly box: React.RefObject<HTMLTextAreaElement | null> }) {
  const d = useDictation();
  const prefs = usePrefs();
  const here = dictatingInto(box.current);
  const now = useClock(here && d.kind === 'listening', 500);
  // An error shows under the box it was meant for, or the chat's if it never started.
  if (d.kind === 'off') {
    const error = errorIn(box.current);
    if (!error) return null;
    return (
      <div className={cx(s.strip, s.error)} role="status">
        <Icon name="mic" size={12} />
        <span className={s.text}>{error}</span>
      </div>
    );
  }
  if (!here) return null;
  const secs = d.kind === 'listening' ? Math.max(0, Math.floor((now - d.since) / 1000)) : 0;
  return (
    <div className={cx(s.strip, d.kind === 'listening' && s.live)} role="status" aria-live="polite">
      {d.kind === 'listening' ? (
        <>
          <span className={s.bars} aria-hidden="true">
            {[0.55, 0.85, 1, 0.75, 0.5].map((k, i) => (
              <span key={i} style={{ transform: `scaleY(${0.18 + Math.min(1, d.level * k * 1.4) * 0.82})` }} />
            ))}
          </span>
          <span className={s.text}>Listening</span>
          <span className={s.time}>
            {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
          </span>
          <span className={s.flex} />
          <span className={s.keys}>
            <Kbd>↩</Kbd> {prefs.voiceSend ? 'send' : 'write it in'} · {prefs.voiceSend ? null : (
              <>
                <Kbd>{mod()}↩</Kbd> send ·{' '}
              </>
            )}
            <Kbd>esc</Kbd>
          </span>
          <button type="button" className={s.done} onMouseDown={(e) => e.preventDefault()} onClick={() => void finishDictation()}>
            Done
          </button>
        </>
      ) : (
        <>
          <span className={s.spinner} />
          <span className={s.text}>{d.kind === 'writing' ? 'Writing it down on this Mac…' : gettingLine(d)}</span>
          <span className={s.flex} />
          {d.kind === 'getting' ? (
            <button type="button" className={s.done} onClick={cancelDictation}>
              Cancel
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
