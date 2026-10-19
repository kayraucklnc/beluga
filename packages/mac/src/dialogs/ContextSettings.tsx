import { useEffect, useState } from 'react';
import { AUTO_COMPACT_MAX, AUTO_COMPACT_MIN, clampThreshold } from '@klaud/shared/context-usage.js';
import { useApi, useApp } from '../lib/klaud.js';
import { Group, Row, Switch } from './settings-controls.js';
import s from './settings.module.css';

/**
 * Settings › Claude › Context: the meter, and compacting on its own when a conversation is nearly
 * full (Claude summarizes its working memory and keeps going; the chat stays on screen).
 */
export function ContextSettings() {
  const api = useApi();
  const p = useApp((st) => st.prefs);
  const saved = clampThreshold(p.autoCompactAt);
  // The slider moves freely; the setting is saved when you let go.
  const [at, setAt] = useState(saved);
  useEffect(() => setAt(saved), [saved]);
  const commit = (): void => {
    if (at !== saved) void api.session.setPrefs({ autoCompactAt: at });
  };
  return (
    <Group title="Context">
      <Row label="Context meter" detail="How full each conversation is, beside the send button.">
        <Switch label="Context meter" on={p.contextMeter} onChange={(v) => void api.session.setPrefs({ contextMeter: v })} />
      </Row>
      <Row
        label="Auto-compact when the context is nearly full"
        detail={p.autoCompact ? 'Between turns, Claude summarizes what it’s keeping and carries on. Nothing leaves the chat.' : 'Claude still compacts on its own right at the limit, so a run never breaks.'}
      >
        <Switch label="Auto-compact" on={p.autoCompact} onChange={(v) => void api.session.setPrefs({ autoCompact: v })} />
      </Row>
      <Row label="Compact at" detail={`When a conversation is ${at}% full`}>
        <input
          className={s.slider}
          type="range"
          aria-label="Compact at"
          min={AUTO_COMPACT_MIN}
          max={AUTO_COMPACT_MAX}
          step={1}
          value={at}
          disabled={!p.autoCompact}
          onChange={(e) => setAt(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
      </Row>
    </Group>
  );
}
