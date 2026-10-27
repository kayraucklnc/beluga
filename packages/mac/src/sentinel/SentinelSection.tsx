import type { ReactNode } from 'react';
import type { View } from '@beluga/core/store.js';
import { Segmented } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/beluga.js';
import type { SentinelTab } from './sentinel-model.js';
import s from './sentinel.module.css';

/**
 * Sentinel's page (docs/sentinel.md §10): one section, three tabs. The switch at the top (the app's
 * Segmented) goes between the Sentinels list, the Dashboard and the Chat; each tab is its own view,
 * so links, ⌘K, the Go menu and Back land on the right one. Coming back to a tab finds it as you
 * left it: the list's project, the dashboard that was open, the chat that is open.
 */

/** Where each tab was last (this window). */
let lastList: View | undefined;
let lastDashboard: string | undefined;

const TABS: ReadonlyArray<{ readonly value: SentinelTab; readonly label: string; readonly icon: 'sentinel' | 'gauge' | 'chat'; readonly hint: string }> = [
  { value: 'sentinels', label: 'Sentinels', icon: 'sentinel', hint: 'Your watchers: when they run, what they do, how it went' },
  { value: 'dashboard', label: 'Dashboard', icon: 'gauge', hint: 'What your sentinels keep and bring back, as tiles' },
  { value: 'chat', label: 'Chat', icon: 'chat', hint: 'Talk to your Claude about all of Sentinel' },
];

export function SentinelSection({ tab, children }: { tab: SentinelTab; children: ReactNode }) {
  const actions = useActions();
  const view = useApp((st) => st.view);
  const active = useApp((st) => st.sentinel.chats?.active);
  const on = useApp((st) => st.sentinel.enabled);
  if (view.kind === 'sentinel') lastList = view;
  if (view.kind === 'dashboard' && view.id) lastDashboard = view.id;
  const go = (next: SentinelTab): void => {
    if (next === tab) return;
    const to: View = next === 'sentinels' ? (lastList ?? { kind: 'sentinel' }) : next === 'dashboard' ? { kind: 'dashboard', ...(lastDashboard ? { id: lastDashboard } : {}) } : { kind: 'sentinel_chat', ...(active ? { chat: active } : {}) };
    actions.run({ type: 'view', view: to });
  };
  return (
    <div className={s.section} data-sentinel-tab={tab}>
      {on ? (
        <div className={s.sectionBar}>
          <Segmented<SentinelTab> label="Sentinel" value={tab} onChange={go} options={TABS} />
        </div>
      ) : null}
      <div className={s.sectionBody}>{children}</div>
    </div>
  );
}
