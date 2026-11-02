import { CHAT_LIMIT_DEFAULT, CHAT_LIMIT_NONE, CHAT_LIMIT_PRESETS } from '@beluga/shared/chat-limit.js';
import { useApi, useApp } from '../lib/beluga.js';
import { Group, Row, Select } from './settings-controls.js';

const label = (n: number): string => (n === CHAT_LIMIT_NONE ? 'No limit' : `${n} chats`);

/**
 * Settings › Agent › Open chats: how many chats Your Mac and Sentinel each keep as tabs. Past it a
 * new chat is refused with a note that points here; No limit never refuses.
 */
export function ChatLimitSettings() {
  const api = useApi();
  const saved = useApp((st) => st.prefs.chatLimit ?? CHAT_LIMIT_DEFAULT);
  // A number set in settings.json by hand still shows as itself.
  const values = CHAT_LIMIT_PRESETS.some((n) => n === saved) ? [...CHAT_LIMIT_PRESETS] : [...CHAT_LIMIT_PRESETS, saved].sort((a, b) => (a || Infinity) - (b || Infinity));
  return (
    <Group title="Open chats">
      <Row
        label="Chats kept at once"
        detail={saved === CHAT_LIMIT_NONE ? 'Your Mac and Sentinel keep as many chats as you start.' : `Your Mac and Sentinel each keep up to ${saved}. Past that, delete one or raise this.`}
      >
        <Select
          label="Open chats"
          value={String(saved)}
          onChange={(v) => void api.session.setPrefs({ chatLimit: Number(v) })}
          options={values.map((n) => ({ value: String(n), label: label(n) }))}
        />
      </Row>
    </Group>
  );
}
