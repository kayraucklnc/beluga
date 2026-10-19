import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { LogItem, ShellItem } from '@klaud/core/store.js';
import { isRunning } from '@klaud/ui/format.js';
import { formatDuration } from '@klaud/shared/text.js';
import { splitImages } from '@klaud/shared/attachment-links.js';
import { Icon } from '../components/Icon.js';
import { Avatar, Button, Dot, cx } from '../components/ui.js';
import { ActionsContext, type ActionItem } from '../components/SpecMenu.js';
import { stopClaude } from '../lib/commands.js';
import { copyText } from '../lib/copy.js';
import { useActions } from '../lib/actions.js';
import { useApp, useKlaud } from '../lib/klaud.js';
import { usePrefs } from '../lib/prefs.js';
import { ImageGrid } from './ChatImages.js';
import { openLightbox } from './images.js';
import { brandText } from '../lib/brand.js';
import { messageItems } from './message-menu.js';
import { Markdown } from './Markdown.js';
import { AgentSteps, StepsToggle } from './steps/AgentSteps.js';
import { useFlightLanding } from './flight.js';
import s from './chat.module.css';

type AgentItem = Extract<LogItem, { type: 'agent' }>;
type ChatItem = Extract<LogItem, { type: 'chat' }>;
type SystemItem = Extract<LogItem, { type: 'system' }>;

/** A clock that ticks while something is running (for "working · 12s"). */
export function useNow(active: boolean, every = 1000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [active, every]);
  return now;
}

const time = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** What a message's right-click menu needs: the box to quote into, and how to reach Claude here. */
function useMenuContext() {
  const { ui, client } = useKlaud();
  // In a group room only a mention reaches Claude; elsewhere quoting already asks it.
  const group = useApp((st) => st.view.kind === 'room' && st.peers.length > 1);
  return { ui, ...(group ? { askPrefix: '@claude ' } : {}), toast: (text: string) => client.store.dispatch({ type: 'toast', text, level: 'success' }) };
}

/** A message from a person (or a Claude speaking in the chat). `continued`: same author, shortly after. */
export const ChatRow = memo(function ChatRow({ item, continued, mine }: { item: ChatItem; continued: boolean; mine: boolean }) {
  const prefs = usePrefs();
  // Screenshots and other images sent with the message show as pictures, under its words.
  const { text, images } = useMemo(() => splitImages(item.text), [item.text]);
  const menu = useMenuContext();
  // The message you just sent flies in from the box (see flight.ts).
  const row = useRef<HTMLDivElement>(null);
  useFlightLanding(row, item.channel, 'chat', item.text, mine && !item.byAgent);
  return (
    <ActionsContext items={() => messageItems({ ...menu, text, images, openImage: (img) => openLightbox(images, images.indexOf(img)) })}>
      <div ref={row} className={cx(s.message, continued && s.continued)} data-mine={mine && !item.byAgent ? 'true' : undefined}>
        <div className={s.gutter}>{continued ? null : <Avatar name={item.name} id={item.from} claude={item.byAgent} size={26} />}</div>
        <div className={s.body}>
          {continued ? null : (
            <div className={s.meta}>
              <span className={cx(s.author, item.byAgent && s.claudeName)}>{mine && !item.byAgent ? 'You' : item.name}</span>
              {prefs.timestamps ? <span className={s.time}>{time(item.ts)}</span> : null}
            </div>
          )}
          {text ? <Markdown text={text} paths={mine} /> : null}
          <ImageGrid images={images} />
        </div>
      </div>
    </ActionsContext>
  );
});

export const SystemRow = memo(function SystemRow({ item }: { item: SystemItem }) {
  const menu = useMenuContext();
  return (
    <ActionsContext items={() => messageItems({ ...menu, text: item.text })}>
        <div className={cx(s.system, item.level === 'warn' && s.systemWarn, item.level === 'error' && s.systemError)}>
          {/* Core words ("klaud") in this app's; a line quoting what someone said stays as written. */}
          <Markdown text={item.said ? item.text : brandText(item.text)} />
        </div>
    </ActionsContext>
  );
});

function statusOf(item: AgentItem, now: number): { label: string; tone: 'claude' | 'ok' | 'error' | 'warn' | 'muted' } {
  switch (item.status) {
    case 'awaiting_approval':
      return { label: `Waiting for ${item.ownerName} to approve`, tone: 'warn' };
    case 'queued':
      return { label: 'Queued', tone: 'muted' };
    case 'done':
      return { label: item.endTs ? `Done in ${formatDuration(item.endTs - item.ts)}` : 'Done', tone: 'ok' };
    case 'error':
      // Stopping or taking a message back is something you did, not a problem.
      if (/^(Taken out of the queue|Cancelled before it started)/.test(item.text)) return { label: 'Not sent', tone: 'muted' };
      if (/^(Stopped by you|Interrupted by a newer message|Stopped by owner)/.test(item.text)) return { label: 'Stopped', tone: 'muted' };
      return { label: 'Stopped', tone: 'error' };
    case 'denied':
      return { label: 'Declined', tone: 'warn' };
    default:
      return { label: `Working · ${formatDuration(now - item.ts)}`, tone: 'claude' };
  }
}

/** What Claude is doing (or did): its steps, sub-agents and background work, then its answer. */
export const AgentCard = memo(function AgentCard({ item }: { item: AgentItem }) {
  const selfId = useApp((st) => st.selfId);
  const running = isRunning(item.status) && item.status !== 'queued';
  const now = useNow(running);
  const st = statusOf(item, now);
  const forSomeoneElse = item.requesterName !== item.ownerName;
  const mine = item.owner === selfId;
  const { client, ui } = useKlaud();
  const actions = useActions();
  const menu = useMenuContext();
  // Your own Claude, working now: it can be stopped from its card.
  const stoppable = mine && running && item.status !== 'awaiting_approval';
  const stop = (): void => stopClaude({ client, ui, actions }, item.channel);
  const lead: ActionItem[] = stoppable ? [{ label: 'Stop Claude', icon: 'stop', keys: '⌘.', onSelect: stop }] : [];
  return (
    <ActionsContext items={() => messageItems({ ...menu, text: item.text, lead })}>
      <div className={cx(s.message, s.agent, running && s.agentLive)}>
        <div className={s.gutter}>
          <Avatar name="Claude" id={item.owner} claude size={26} />
        </div>
        <div className={s.body}>
          <div className={s.meta}>
            <span className={cx(s.author, s.claudeName)}>{mine ? 'Claude' : `${item.ownerName}'s Claude`}</span>
            {forSomeoneElse ? <span className={s.time}>for {item.requesterName}</span> : null}
            {!running && item.text && item.status === 'done' ? (
              <span className={s.hoverActions}>
                {mine && item.steps.length ? <StepsToggle item={item} /> : null}
                <Button size="small" variant="quiet" icon="copy" onClick={() => void copyText(item.text).then(() => menu.toast('Copied the answer'))}>
                  Copy
                </Button>
              </span>
            ) : stoppable ? (
              <span className={s.hoverActions}>
                <Button size="small" variant="quiet" icon="stop" onClick={stop} title="Stop Claude here (⌘.)">
                  Stop
                </Button>
              </span>
            ) : null}
            <span className={cx(s.status, s[`tone_${st.tone}`])}>
              {running ? <Dot tone="claude" live /> : null}
              {st.label}
            </span>
          </div>
          {/* Steps open to show what ran and what came back (see steps/AgentSteps.tsx). */}
          <AgentSteps item={item} running={running} />
          {item.text ? (
            <Markdown text={item.text} paths />
          ) : item.status === 'queued' ? (
            // Sending it now, editing or moving it: the queue above the box.
            <div className={s.idle}>Starts when the current task finishes.</div>
          ) : null}
        </div>
      </div>
    </ActionsContext>
  );
});

/** A command that ran (or waits to run) on someone's computer, with its output. */
export const ShellCard = memo(function ShellCard({ item }: { item: ShellItem }) {
  const running = item.status === 'running' || item.status === 'waiting';
  const now = useNow(running);
  const label =
    item.status === 'waiting'
      ? `Waiting for ${item.ownerName} to approve`
      : item.status === 'running'
        ? `Running on ${item.ownerName}'s computer · ${formatDuration(now - (item.startTs ?? item.ts))}`
        : item.status === 'declined'
          ? `${item.ownerName} declined`
          : item.status === 'failed'
            ? item.error ?? `Exit ${item.exitCode ?? '?'}`
            : `Exit ${item.exitCode ?? 0}${item.endTs && item.startTs ? ` · ${formatDuration(item.endTs - item.startTs)}` : ''}`;
  const tone = item.status === 'done' && (item.exitCode ?? 0) === 0 ? 'ok' : item.status === 'done' || item.status === 'failed' ? 'error' : item.status === 'declined' ? 'warn' : 'claude';
  const menu = useMenuContext();
  const copy = (text: string, what: string): void => void copyText(text).then(() => menu.toast(`Copied ${what}`));
  const items: ActionItem[] = [
    { label: 'Copy Command', icon: 'copy', onSelect: () => copy(item.command, 'the command') },
    ...(item.output ? [{ label: 'Copy Output', onSelect: () => copy(item.output ?? '', 'the output') }] : []),
  ];
  return (
    <ActionsContext items={items}>
      <div className={cx(s.message, s.shell)}>
        <div className={s.gutter}>
          <span className={s.shellIcon}>
            <Icon name="terminal" size={14} />
          </span>
        </div>
        <div className={s.body}>
          <div className={s.meta}>
            <span className={s.author}>{item.by}</span>
            <span className={s.time}>on {item.ownerName}'s computer{item.cwd ? ` · ${item.cwd}` : ''}</span>
            <span className={cx(s.status, s[`tone_${tone}`])}>
              {running ? <Dot tone="claude" live /> : null}
              {label}
            </span>
          </div>
          <pre className={`${s.shellOut} selectable`}>
            <span className={s.prompt}>$ </span>
            {item.command}
            {item.output ? `\n${item.output}` : ''}
            {item.truncated ? '\n…' : ''}
          </pre>
        </div>
      </div>
    </ActionsContext>
  );
});
