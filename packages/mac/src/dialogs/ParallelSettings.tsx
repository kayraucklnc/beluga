import { useEffect, useState } from 'react';
import { PARALLEL_RUNS_MAX, PARALLEL_RUNS_MIN, clampParallelRuns } from '@beluga/shared/run-slots.js';
import { useApi, useApp } from '../lib/beluga.js';
import { Group, Row } from './settings-controls.js';
import s from './settings.module.css';

/**
 * Settings › Claude › Working at once: how many conversations your Claude works in at the same
 * time. A message past it waits for one to finish, and its card says so.
 */
export function ParallelSettings() {
  const api = useApi();
  const saved = clampParallelRuns(useApp((st) => st.prefs.parallelRuns));
  // The slider moves freely; the setting is saved when you let go.
  const [n, setN] = useState(saved);
  useEffect(() => setN(saved), [saved]);
  const commit = (): void => {
    if (n !== saved) void api.session.setPrefs({ parallelRuns: n });
  };
  return (
    <Group title="Working at once">
      <Row
        label="Conversations Claude works in at once"
        detail={`Up to ${n} at the same time. Past that, a message waits its turn and says so.`}
      >
        <span className={s.sliderEnds}>
          <span>Fewer</span>
          <input
            className={s.slider}
            type="range"
            aria-label="Conversations at once"
            min={PARALLEL_RUNS_MIN}
            max={PARALLEL_RUNS_MAX}
            step={1}
            value={n}
            onChange={(e) => setN(Number(e.target.value))}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
          />
          <span>More</span>
        </span>
      </Row>
    </Group>
  );
}
