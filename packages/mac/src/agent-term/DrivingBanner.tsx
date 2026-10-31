import { Icon } from '../components/Icon.js';
import { Button } from '../components/ui.js';
import { useApi, useApp, useBeluga, toast } from '../lib/beluga.js';
import { convoModeOf, withConvoMode } from '../lib/convo-mode.js';
import { getPrefs, setPrefs } from '../lib/prefs.js';
import s from './agent-term.module.css';

/**
 * In place of the message box while the agent's own terminal drives this conversation (BLG-534):
 * the chat follows along, and Take over gives the conversation back to it (the terminal closes,
 * what was said there is already here).
 */
export function DrivingBanner({ wsId }: { readonly wsId: string }) {
  const api = useApi();
  const { client } = useBeluga();
  const driving = useApp((st) => st.agentTerms[wsId]);
  if (!driving) return null;
  const mode = convoModeOf(getPrefs().convoModes, getPrefs().convoDefault, wsId);
  const takeOver = async (): Promise<void> => {
    try {
      await api.agentTerm.takeOver(wsId);
      if (convoModeOf(getPrefs().convoModes, getPrefs().convoDefault, wsId) === 'terminal') setPrefs({ convoModes: withConvoMode(getPrefs().convoModes, wsId, 'chat') });
      setTimeout(() => document.dispatchEvent(new CustomEvent('beluga:focus-composer')), 60);
    } catch (err) {
      toast(client, err instanceof Error ? err.message : String(err), 'error');
    }
  };
  return (
    <div className={s.driving} role="status">
      <Icon name="terminal" size={14} />
      <span className={s.drivingText}>{driving.label}’s terminal is driving this conversation</span>
      {mode === 'chat' ? (
        <Button size="small" variant="quiet" icon="terminal" onClick={() => setPrefs({ convoModes: withConvoMode(getPrefs().convoModes, wsId, 'terminal') })}>
          Show Terminal
        </Button>
      ) : null}
      <Button size="small" onClick={() => void takeOver()}>
        Take Over
      </Button>
    </div>
  );
}
