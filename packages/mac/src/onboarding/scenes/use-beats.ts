import { useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { usePrefs } from '../../lib/prefs.js';

/**
 * A scene's beats: each lasts its own time (ms), then the next one plays, round and round
 * (`onLoop` when it starts over).
 * With Reduce Motion (the Mac's, or Klaud's own) the scene holds on `rest`, the beat that
 * explains it best on its own.
 */
export function useBeats(durations: readonly number[], rest = durations.length - 1, onLoop?: () => void): number {
  const still = (useReducedMotion() ?? false) || usePrefs().reduceMotion;
  const [beat, setBeat] = useState(still ? rest : 0);
  useEffect(() => {
    if (still) {
      setBeat(rest);
      return;
    }
    const t = setTimeout(() => {
      if (beat === durations.length - 1) onLoop?.();
      setBeat((beat + 1) % durations.length);
    }, durations[beat]);
    return () => clearTimeout(t);
  }, [beat, still]);
  return beat;
}
