import { useRef, useState } from 'react';
import { cx } from '../../components/ui.js';
import { useApp } from '../../lib/klaud.js';
import { DRAWER_DEFAULT, DRAWER_MAX, DRAWER_MIN, clampShare, drawerFits } from '../../lib/panel-model.js';
import { setPrefs, usePrefs } from '../../lib/prefs.js';
import { ResizeHandle, usePresence } from './ResizeHandle.js';
import { TerminalPane } from './TerminalPane.js';
import s from './panel.module.css';

const SLIDE_MS = 200;

/**
 * The terminal drawer (⌘J, when that's where you keep the terminal): it slides up under the
 * conversation, across the center, as tall as you drag it.
 */
export function TerminalDrawer({ column }: { column: React.RefObject<HTMLElement | null> }) {
  const prefs = usePrefs();
  const view = useApp((st) => st.view);
  const open = prefs.drawer && drawerFits(view);
  const presence = usePresence(open, SLIDE_MS);
  const [drag, setDrag] = useState<number>();
  const latest = useRef(prefs.drawerSize);
  if (!presence.mounted) return null;
  const size = clampShare(drag ?? prefs.drawerSize, DRAWER_MIN, DRAWER_MAX);
  latest.current = size;
  return (
    <div className={cx(s.drawer, presence.closing && s.drawerClosing, drag !== undefined && s.dragging)} style={{ height: `${Math.round(size * 1000) / 10}%` }}>
      <ResizeHandle
        axis="y"
        label="Resize the terminal drawer"
        className={s.drawerEdge}
        onMove={(y) => {
          const r = column.current?.getBoundingClientRect();
          if (r) setDrag(clampShare((r.bottom - y) / r.height, DRAWER_MIN, DRAWER_MAX));
        }}
        onEnd={() => {
          setPrefs({ drawerSize: latest.current });
          setDrag(undefined);
        }}
        onReset={() => setPrefs({ drawerSize: DRAWER_DEFAULT })}
        onStep={(dir) => setPrefs({ drawerSize: clampShare(size + dir * 0.04, DRAWER_MIN, DRAWER_MAX) })}
      />
      {presence.closing ? null : <TerminalPane where="drawer" onClose={() => setPrefs({ drawer: false })} />}
    </div>
  );
}
