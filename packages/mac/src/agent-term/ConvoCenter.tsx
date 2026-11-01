import { useRef, useState } from 'react';
import { ResizeHandle } from '../layout/panel/ResizeHandle.js';
import { useApp } from '../lib/beluga.js';
import { BOTH_MAX, BOTH_MIN, centerShows, clampBoth, hasAgentTurn, isConvoMode, shownMode, terminalCapable } from '../lib/convo-mode.js';
import { activityOf } from '@beluga/ui/workspace-models.js';
import { setPrefs, usePrefs } from '../lib/prefs.js';
import { ChatView } from '../views/ChatView.js';
import { AgentTermView } from './AgentTermView.js';
import { TurnWaitBanner } from './TurnWaitBanner.js';
import s from './agent-term.module.css';

/** Whether a workspace's conversation can show as a terminal (lib/convo-mode.ts: not Codex's). */
export const useTerminalCapable = (wsId: string | undefined): boolean => useApp((st) => terminalCapable(st, wsId));

/**
 * A workspace's conversation in the middle of the window, as you chose to see it (BLG-534): the
 * chat, the agent's own terminal on it, or the terminal with the chat beside it.
 */
export function ConvoCenter({ wsId }: { readonly wsId: string }) {
  const prefs = usePrefs();
  const capable = useTerminalCapable(wsId);
  const turnRunning = useApp((st) => activityOf(st.log, `ws:${wsId}`).running);
  const driving = useApp((st) => Boolean(st.agentTerms[wsId]));
  const started = useApp((st) => hasAgentTurn(st.log, `ws:${wsId}`));
  const mode = centerShows(capable ? shownMode(prefs, wsId) : 'chat', { turnRunning, driving, started, picked: isConvoMode(prefs.convoModes[wsId]) });
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | undefined>(undefined);
  // Before its first turn it's the chat: your first message opens the terminal on it (lib/convo-mode.ts).
  if (mode === 'chat' || mode === 'fresh') return <ChatView />;
  // A turn in the chat first (BLG-553): watch it there; the terminal opens when it ends.
  if (mode === 'waiting')
    return (
      <div className={s.waitingChat}>
        <TurnWaitBanner wsId={wsId} />
        <ChatView />
      </div>
    );
  if (mode === 'terminal') return <AgentTermView wsId={wsId} />;
  const share = clampBoth(drag ?? prefs.bothChat);
  return (
    <div ref={box} className={s.both}>
      <div className={s.bothTerm}>
        <AgentTermView wsId={wsId} />
      </div>
      <ResizeHandle
        axis="x"
        label="Resize the chat beside the terminal"
        className={s.bothEdge}
        onMove={(x) => {
          const r = box.current?.getBoundingClientRect();
          if (r) setDrag((r.right - x) / r.width);
        }}
        onEnd={() => {
          if (drag !== undefined) setPrefs({ bothChat: clampBoth(drag) });
          setDrag(undefined);
        }}
        onReset={() => setPrefs({ bothChat: 0.38 })}
        onStep={(dir) => setPrefs({ bothChat: Math.min(BOTH_MAX, Math.max(BOTH_MIN, share + dir * 0.03)) })}
      />
      <div className={s.bothChat} style={{ flexBasis: `${Math.round(share * 1000) / 10}%` }}>
        <ChatView />
      </div>
    </div>
  );
}
