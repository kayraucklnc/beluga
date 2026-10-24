import { ASSISTANT_CHANNEL, ASSISTANT_TITLE } from '@beluga/shared/assistant.js';
import { Icon } from '../components/Icon.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { signalOf } from './attention-model.js';
import { SignalMark } from './signal-marks.js';
import { Row } from './sidebar-parts.js';

/**
 * The sidebar's top row: "Your Mac" (core/assistant), your Claude for the whole Mac, not one
 * project. The same conversation as the phone's Ask your Mac: what you say on either shows on both.
 */
export function AssistantNav() {
  const actions = useActions();
  const selected = useApp((s) => s.view.kind === 'assistant');
  const signal = useApp((s) => signalOf(s, ASSISTANT_CHANNEL), sameDeep);
  return (
    <Row
      icon={<Icon name="laptop" size={14} />}
      label={ASSISTANT_TITLE}
      detail={signal.tip || 'Ask your Mac anything: screenshots, what’s running, start a worktree or a task. The same conversation as on your phone'}
      selected={selected}
      onClick={() => actions.run({ type: 'view', view: { kind: 'assistant' } })}
      trailing={<SignalMark signal={signal} />}
    />
  );
}
