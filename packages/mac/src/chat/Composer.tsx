import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type AppState, channelOf, peerName } from '@klaud/core/store.js';
import { localDirKey } from '@klaud/core/local-key.js';
import { workspaceMentions } from '@klaud/core/mentions.js';
import { composeState, queueIn } from '@klaud/ui/compose.js';
import { localDirOf, openTarget, suggest, type Suggestion } from '@klaud/ui/suggest.js';
import { Icon } from '../components/Icon.js';
import { Kbd, Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { toast, useApi, useApp, useKlaud, useUi } from '../lib/klaud.js';
import { usePrefs } from '../lib/prefs.js';
import { mod } from '../lib/system.js';
import { ModelPicker } from './ModelPicker.js';
import { QueueTray } from './QueueTray.js';
import { keepPreview, previewOf } from './images.js';
import s from './composer.module.css';
import img from './images.module.css';

const CHIP = /\[image (\d+)\]/g;
/** The "[image N]" chips in the text, in order, once each. */
const chipsIn = (text: string): number[] => [...new Set([...text.matchAll(CHIP)].map((m) => Number(m[1])))];

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The words in the box, before you start typing: what it does here. */
function placeholderOf(state: AppState, ui: { pending?: { kind: string; projectId: string; peerId?: string } }): string {
  const q = state.questions[0];
  if (q && q.channel === channelOf(state.view)) return q.question.kind === 'plan' ? 'Approve the plan above, or say what to change' : 'Type your own answer, or pick an option above';
  const p = ui.pending;
  if (p?.kind === 'peer_run') return `A command to run on ${peerName(state, p.peerId ?? '')}'s computer`;
  if (p?.kind === 'remote') return 'Describe the task for their Claude';
  if (p?.kind === 'setup' || p?.kind === 'run') return `The project's ${p.kind} command (empty to clear it)`;
  if (p) return `Name for the new ${p.kind}${state.projects.find((x) => x.id === p.projectId)?.root ? ` in ${state.projects.find((x) => x.id === p.projectId)?.name}` : ''}`;
  const v = state.view;
  if (v.kind === 'draft') return 'Ask Claude anything. Your first message starts the chat';
  if (v.kind === 'draft_worktree') return 'Describe the task. Return creates the worktree and starts Claude';
  if (v.kind === 'search') return 'Search every conversation';
  if (v.kind === 'workspace') {
    const ws = state.projects.flatMap((x) => x.workspaces).find((w) => w.id === v.id);
    return `Tell Claude what to do in ${ws?.name ?? 'this workspace'}`;
  }
  if (v.kind === 'shared') {
    const w = state.shared.find((x) => x.id === v.id);
    if (v.tab === 'terminal') return 'Type a command: ls, cd, cat, tree, find, grep';
    return w?.role === 'view' ? `You're following ${w.name}` : `Message ${w?.name ?? 'the workspace'}`;
  }
  return state.peers.length <= 1 ? 'Talk to your Claude · @workspace reaches the Claude working there · / for commands' : 'Message the room · @claude:name asks someone’s Claude';
}

export function Composer({ autoFocus = true }: { autoFocus?: boolean }) {
  const { ui, client } = useKlaud();
  const api = useApi();
  const actions = useActions();
  const prefs = usePrefs();
  const state = useApp((st) => st);
  const buffer = useUi((u) => u.buffer);
  const pending = useUi((u) => u.pending);
  const [selected, setSelected] = useState(0);
  const [hidden, setHidden] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const channel = channelOf(state.view);
  const shared = state.view.kind === 'shared';
  const compose = composeState(state, ui.get(), state.selfId, channel, shared);
  const queue = useMemo(() => queueIn(state, channel, state.selfId), [state.log, channel, state.selfId]);
  // Pictures of the images pasted or dropped here, until they're sent.
  const pendingImages = chipsIn(buffer).filter((n) => previewOf(n));
  // While Claude works, sending queues the message; "Send now" interrupts it.
  const queueing = compose.busy && (compose.typing || !buffer.trim());
  const plan = state.planMode[channel] === true;
  const readOnly = state.view.kind === 'shared' && state.view.tab === 'chat' && state.shared.find((w) => w.id === (state.view as { id: string }).id)?.role === 'view';

  // Suggestions as you type: commands, people and Claudes, workspaces, folders.
  const suggestions: Suggestion[] = useMemo(
    () =>
      hidden || !buffer
        ? []
        : suggest(buffer, {
            peers: state.peers,
            selfId: state.selfId,
            dirCache: state.dirCache,
            listLocalDirs: (dir) => state.dirCache[localDirKey(dir)] ?? [],
            workspaces: state.view.kind === 'room' ? workspaceMentions(state.projects) : [],
          }),
    [buffer, hidden, state.peers, state.selfId, state.dirCache, state.view.kind, state.projects],
  );
  const pick = Math.min(selected, Math.max(0, suggestions.length - 1));

  // Folders to suggest for "/project add …", and shared files for "/open …".
  const localDir = localDirOf(buffer);
  useEffect(() => {
    if (localDir !== undefined) void api.local.listDirs(localDir);
  }, [localDir]);
  const target = openTarget(buffer, state.peers);
  const targetKey = target ? `${target.owner}:${target.share}/${target.path}` : '';
  useEffect(() => {
    if (target) void api.files.loadDir(target);
  }, [targetKey]);

  // Grow with what you write, up to a dozen lines.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 12 * 20 + 16)}px`;
  }, [buffer]);
  useEffect(() => {
    const focus = (): void => ref.current?.focus();
    document.addEventListener('klaud:focus-composer', focus);
    return () => document.removeEventListener('klaud:focus-composer', focus);
  }, []);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [state.view, autoFocus]);

  const set = (text: string): void => {
    ui.patch({ buffer: text, cursor: text.length });
    setHidden(false);
    setSelected(0);
  };
  const send = (urgent = false): void => {
    const text = buffer.trim();
    if (!text) return;
    ui.patch({ buffer: '', cursor: 0, history: [...ui.get().history, text].slice(-200), historyIndex: -1 });
    // Image chips become links to the images (klaud keeps them) before the message goes.
    if (text.includes('[image ') && !text.startsWith('/')) {
      api.attachments.expand(text, channel).then(
        (expanded) => actions.submit(expanded, urgent),
        (err: unknown) => {
          // Put the message back so nothing typed is lost.
          if (!ui.get().buffer) ui.patch({ buffer: text, cursor: text.length });
          toast(client, `Couldn't send the images: ${errorText(err)}`, 'error');
        },
      );
      return;
    }
    actions.submit(text, urgent);
  };
  /** Images pasted or dropped become "[image N]" chips where the cursor is. */
  const attach = async (files: readonly File[]): Promise<void> => {
    for (const file of files) {
      const ext = (/image\/(png|jpe?g|gif|webp)/.exec(file.type)?.[1] ?? 'png') as 'png' | 'jpg' | 'jpeg' | 'gif' | 'webp';
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      let chip: string;
      try {
        const added = await api.attachments.add(ext, btoa(bin));
        chip = added.chip;
        keepPreview(added.n, file);
      } catch (err) {
        toast(client, `Couldn't add ${file.name || 'the image'}: ${errorText(err)}`, 'error');
        continue;
      }
      const el = ref.current;
      const at = el?.selectionStart ?? ui.get().buffer.length;
      const current = ui.get().buffer;
      const before = current.slice(0, at);
      const gap = before && !before.endsWith(' ') ? ' ' : '';
      const next = `${before}${gap}${chip} ${current.slice(at)}`;
      ui.patch({ buffer: next, cursor: before.length + gap.length + chip.length + 1 });
      requestAnimationFrame(() => el?.setSelectionRange(before.length + gap.length + chip.length + 1, before.length + gap.length + chip.length + 1));
    }
  };
  const imagesOf = (items: DataTransferItemList | undefined): File[] =>
    [...(items ?? [])].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter((f): f is File => Boolean(f));
  const [dropping, setDropping] = useState(false);
  /** Take an image out of the message (its chip, and the space after it). */
  const removeImage = (n: number): void => {
    const next = buffer.replace(new RegExp(`\\[image ${n}\\] ?`, 'g'), '');
    ui.patch({ buffer: next, cursor: Math.min(ui.get().cursor, next.length) });
    ref.current?.focus();
  };
  /** A queued message pulled back to edit: into the box, ahead of anything already there. */
  const editQueued = (prompt: string): void => {
    const toClaude = channel === 'room' && state.peers.length > 1 && !prompt.startsWith('@') ? `@claude ${prompt}` : prompt;
    const current = ui.get().buffer.trim();
    set(current ? `${toClaude}\n${current}` : toClaude);
    ref.current?.focus();
  };
  const sendKeys = prefs.sendWith === 'enter' ? '↩' : `${mod()}↩`;
  const accept = (sug: Suggestion): void => {
    if (sug.enter === 'submit') {
      ui.patch({ buffer: '', cursor: 0 });
      actions.submit(sug.value);
      return;
    }
    set(sug.value);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter while an input method is composing (Japanese, Chinese…) picks the characters.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const modKey = e.metaKey || e.ctrlKey;
    if (suggestions.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((n) => (n + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !modKey && suggestions[pick]?.value !== buffer)) {
        e.preventDefault();
        accept(suggestions[pick]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setHidden(true);
        return;
      }
    }
    if (e.key === 'Escape') {
      if (pending) ui.patch({ pending: undefined, buffer: '' });
      else if (state.view.kind === 'draft' || state.view.kind === 'draft_worktree') client.store.dispatch({ type: 'view', view: state.view.back });
      return;
    }
    if (e.key === 'Enter') {
      const sends = prefs.sendWith === 'enter' ? !e.shiftKey && !modKey : modKey;
      if (e.altKey) {
        e.preventDefault();
        send(true);
        return;
      }
      if (sends) {
        e.preventDefault();
        send(false);
      }
      return;
    }
    // ↑ on an empty box brings back what you sent last.
    if (e.key === 'ArrowUp' && !buffer) {
      const h = ui.get().history;
      if (h.length) {
        e.preventDefault();
        set(h[h.length - 1]!);
      }
    }
  };
  const askingFor = pending
    ? pending.kind === 'peer_run'
      ? 'Command'
      : pending.kind === 'remote'
        ? 'Task'
        : pending.kind === 'setup' || pending.kind === 'run'
          ? `${pending.kind[0]!.toUpperCase()}${pending.kind.slice(1)} command`
          : `New ${pending.kind}`
    : undefined;

  return (
    <div className={s.wrap}>
      {suggestions.length ? (
        <div className={s.suggestions} role="listbox">
          {suggestions.slice(0, 50).map((sug, i) => (
            <div key={`${sug.value}:${i}`} role="option" aria-selected={i === pick} className={cx(s.suggestion, i === pick && s.suggestionOn)} onMouseEnter={() => setSelected(i)} onMouseDown={(e) => (e.preventDefault(), accept(sug))}>
              <span className={s.sugLabel}>{sug.label}</span>
              <span className={s.sugHint}>{sug.hint}</span>
            </div>
          ))}
        </div>
      ) : null}
      <QueueTray queue={queue} selfName={state.self?.name ?? ''} onEdit={editQueued} />
      <div
        className={cx(s.box, pending && s.asking, readOnly && s.readOnly, dropping && s.dropping)}
        onDragOver={(e) => {
          if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) {
            e.preventDefault();
            setDropping(true);
          }
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          const files = imagesOf(e.dataTransfer.items);
          setDropping(false);
          if (!files.length) return;
          e.preventDefault();
          void attach(files);
        }}
      >
        {askingFor ? (
          <div className={s.askChip}>
            {askingFor}
            <button type="button" aria-label="Cancel" onClick={() => ui.patch({ pending: undefined, buffer: '' })}>
              <Icon name="x" size={10} />
            </button>
          </div>
        ) : null}
        {pendingImages.length ? (
          <div className={img.pending} role="group" aria-label="Images to send">
            {pendingImages.map((n) => (
              <div key={n} className={img.pendingItem}>
                <img src={previewOf(n)} alt={`image ${n}`} />
                <span className={img.pendingLabel}>{n}</span>
                <button type="button" className={img.pendingRemove} aria-label={`Remove image ${n}`} onClick={() => removeImage(n)}>
                  <Icon name="x" size={9} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <textarea
          ref={ref}
          className={`${s.input} selectable`}
          rows={1}
          value={buffer}
          disabled={readOnly}
          placeholder={placeholderOf(state, pending ? { pending } : {})}
          onChange={(e) => set(e.target.value)}
          onKeyDown={onKey}
          onPaste={(e) => {
            const files = imagesOf(e.clipboardData.items);
            if (!files.length) return;
            e.preventDefault();
            void attach(files);
          }}
          spellCheck
        />
        <div className={s.bar}>
          {channel !== 'draft' && !shared ? (
            <Tip label={plan ? 'Plan mode: Claude looks first and asks you to approve a plan' : 'Act right away (click for plan mode)'} keys="⇧Tab">
              <button type="button" className={cx(s.chip, plan && s.chipOn)} onClick={() => void api.session.setPlanMode(channel, !plan)}>
                <Icon name="wand" size={12} />
                {plan ? 'Plan first' : 'Act'}
              </button>
            </Tip>
          ) : null}
          {!shared ? <ModelPicker channel={channel} /> : null}
          <span className={s.flex} />
          {queueing ? (
            <div className={cx(s.split, buffer.trim() && s.splitReady)} role="group" aria-label="Claude is working">
              <Tip label="Claude is working: this waits its turn in the queue" keys={sendKeys}>
                <button type="button" className={s.splitMain} onClick={() => send(false)} disabled={!buffer.trim()}>
                  <Icon name="clock" size={12} />
                  Queue
                </button>
              </Tip>
              <Tip label="Stop Claude's current task and send this now" keys="⌥↩">
                <button type="button" className={s.splitAlt} onClick={() => send(true)} disabled={!buffer.trim()}>
                  Send now
                </button>
              </Tip>
            </div>
          ) : (
            <Tip label={prefs.sendWith === 'enter' ? 'Send · Shift+Return for a new line' : `Send · ${mod()}Return`} keys={prefs.sendWith === 'enter' ? '↩' : `${mod()}↩`}>
              <button type="button" className={cx(s.send, buffer.trim() && s.sendReady)} onClick={() => send(false)} aria-label="Send" disabled={!buffer.trim()}>
                <Icon name="send" size={14} />
              </button>
            </Tip>
          )}
        </div>
      </div>
      <div className={s.legend}>
        {queueing ? (
          <>
            <Kbd>{sendKeys}</Kbd> queue · <Kbd>⌥↩</Kbd> send now, interrupting Claude
          </>
        ) : prefs.sendWith === 'enter' ? (
          <>
            <Kbd>↩</Kbd> send · <Kbd>⇧↩</Kbd> new line
          </>
        ) : (
          <>
            <Kbd>{mod()}↩</Kbd> send
          </>
        )}
        {' · '}
        <Kbd>/</Kbd> commands · <Kbd>@</Kbd> people and Claudes · <Kbd>{mod()}K</Kbd> everything
      </div>
    </div>
  );
}
