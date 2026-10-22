import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type AppState, channelOf, peerName } from '@klaud/core/store.js';
import { localDirKey } from '@klaud/core/local-key.js';
import { workspaceMentions } from '@klaud/core/mentions.js';
import { composeState, queueIn } from '@klaud/ui/compose.js';
import { localDirOf, mentionDir, openTarget, suggest, type Suggestion } from '@klaud/ui/suggest.js';
import { shareNameOf } from '@klaud/shared/share-names.js';
import { Icon } from '../components/Icon.js';
import { Kbd, Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { recipientLabel, recipientPrefix, toast, useApi, useApp, useKlaud, useUi } from '../lib/klaud.js';
import { usePrefs } from '../lib/prefs.js';
import { mod } from '../lib/system.js';
import { ModelPicker } from './ModelPicker.js';
import { ContextMeter } from './ContextMeter.js';
import { QueueTray } from './QueueTray.js';
import { expectClaude, launchFlight } from './flight.js';
import { type WorktreeChoice, WorktreeDraft } from './WorktreeDraft.js';
import { stopClaude } from '../lib/commands.js';
import { keepPreview, previewOf } from './images.js';
import { type PathInfo, usePastePaths } from './paste-paths.js';
import { MentionHighlighter } from './MentionHighlighter.js';
import { useSuggestions } from './Suggestions.js';
import { useMentionWorld, worktreeOf } from './Mention.js';
import { ActionsDropdown } from '../components/SpecMenu.js';
import { openSheet } from '../lib/sheets.js';
import { type ComposeMode, MODE_INFO, nextMode } from './compose-mode.js';
import { isPlanHome, planForHome } from '@klaud/core/plans/model.js';
import s from './composer.module.css';
import img from './images.module.css';
import d from './draft.module.css';

/** Images waiting to be sent, per conversation (so switching away and back keeps them). */
const waitingImages = new Map<string, readonly number[]>();
/** Other files (their paths were pasted) waiting to go with the message, per conversation. */
const waitingFiles = new Map<string, readonly PathInfo[]>();
/** How the words refer to a waiting image (it becomes a link to it when sent). */
const imageRef = (n: number): string => `[image ${n}]`;

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
  if (v.kind === 'draft') {
    // A chat in a project runs in its main folder: questions only.
    const project = state.projects.find((x) => x.id === v.projectId && x.root);
    return project ? `Ask about ${project.name}…` : 'Ask Claude anything. Your first message starts the chat';
  }
  if (v.kind === 'draft_worktree') return 'What should Claude work on in the new worktree?';
  if (v.kind === 'search') return 'Search every conversation';
  if (v.kind === 'workspace') {
    const ws = state.projects.flatMap((x) => x.workspaces).find((w) => w.id === v.id);
    if (ws?.askOnly) return `Ask about ${state.projects.find((x) => x.root && x.workspaces.includes(ws))?.name ?? 'this project'}…`;
    return `Tell Claude what to do in ${ws?.name ?? 'this workspace'}`;
  }
  if (v.kind === 'shared') {
    const w = state.shared.find((x) => x.id === v.id);
    return w?.role === 'view' ? `You're following ${w.name}` : `Message ${w?.name ?? 'the workspace'}`;
  }
  return state.peers.length <= 1 ? 'Message your Claude' : 'Message the room';
}

export function Composer({ autoFocus = true }: { autoFocus?: boolean }) {
  const { ui, client } = useKlaud();
  const api = useApi();
  const actions = useActions();
  const prefs = usePrefs();
  const state = useApp((st) => st);
  const buffer = useUi((u) => u.buffer);
  const pending = useUi((u) => u.pending);
  // Addressed to someone (a person's card › Message / Ask Claude): the chip says who; sending says it to them.
  const to = useUi((u) => u.to);
  const ref = useRef<HTMLTextAreaElement>(null);
  const channel = channelOf(state.view);
  const shared = state.view.kind === 'shared';
  const compose = composeState(state, ui.get(), state.selfId, channel, shared);
  const queue = useMemo(() => queueIn(state, channel, state.selfId), [state.log, channel, state.selfId]);
  // Images pasted or dropped here wait as thumbnails above the text, with an "[image N]" where
  // the cursor was so the words can point at them, and go with the message. Kept per conversation.
  const [images, setImagesState] = useState<readonly number[]>(() => waitingImages.get(channel) ?? []);
  useEffect(() => setImagesState(waitingImages.get(channel) ?? []), [channel]);
  const setImages = (next: readonly number[]): void => {
    waitingImages.set(channel, next);
    setImagesState(next);
  };
  const pendingImages = images.filter((n) => previewOf(n));
  const [files, setFilesState] = useState<readonly PathInfo[]>(() => waitingFiles.get(channel) ?? []);
  useEffect(() => setFilesState(waitingFiles.get(channel) ?? []), [channel]);
  const setFiles = (next: readonly PathInfo[]): void => {
    if (next.length) waitingFiles.set(channel, next);
    else waitingFiles.delete(channel);
    setFilesState(next);
  };
  // While Claude works, sending queues the message; "Steer" gives it to Claude at its next step.
  const queueing = compose.busy && (compose.typing || !buffer.trim());
  const plan = state.planMode[channel] === true;
  // Plan with Tasks: this conversation is a plan's home (milestones and tasks, approved onto the board).
  const homePlan = planForHome(state.plans, channel);
  // While it's being planned (once approved, the conversation is the plan's head and the box is as usual).
  const tasksMode = Boolean(homePlan && !homePlan.body);
  // A plan's own conversation (its head Claude plans and runs it here): no modes to pick, the plan is what it's for.
  const planHome = isPlanHome(state.plans, channel);
  const canPlanTasks = state.plans.enabled && channel.startsWith('ws:') && state.projects.some((p) => p.root && p.workspaces.some((w) => `ws:${w.id}` === channel));
  const mode: ComposeMode = tasksMode ? 'tasks' : plan ? 'plan' : 'act';
  const setMode = (next: ComposeMode): void => {
    const leave = (): void => {
      if ((next === 'plan') !== plan) void api.session.setPlanMode(channel, next === 'plan');
    };
    // Leaving a draft plan: an empty one just goes; one with something in it is thrown away only if you say so.
    if (next !== 'tasks' && tasksMode && homePlan) {
      if (!homePlan.draft?.milestones.length) {
        void api.plans.discard(homePlan.id);
        return leave();
      }
      openSheet({ kind: 'confirm', title: 'Throw away the draft plan?', message: 'Nothing of it is on the board. To keep it, approve it on its page instead.', confirm: 'Throw Away', destructive: true, run: () => (void api.plans.discard(homePlan.id), leave()) });
      return;
    }
    leave();
    if (next === 'tasks' && !tasksMode) void api.plans.here(channel).catch((err: unknown) => toast(client, err instanceof Error ? err.message : String(err), 'error'));
  };
  const readOnly = state.view.kind === 'shared' && state.view.tab === 'chat' && state.shared.find((w) => w.id === (state.view as { id: string }).id)?.role === 'view';
  // A new worktree: the branch it starts from and its name (empty: named from the task).
  const draftProject = state.view.kind === 'draft_worktree' ? state.view.projectId : undefined;
  const [worktree, setWorktree] = useState<WorktreeChoice>({ name: '' });
  useEffect(() => setWorktree({ name: '' }), [draftProject]);
  const canCreate = Boolean(buffer.trim() && !buffer.trim().startsWith('/')) || Boolean(worktree.name.trim());

  // "@src/au" in a worktree: its folders and files (loaded as you type into a folder).
  const wsId = worktreeOf(channel);
  const atDir = wsId ? mentionDir(buffer) : undefined;
  useEffect(() => {
    if (wsId && atDir !== undefined) void api.files.loadDir({ owner: state.selfId, share: shareNameOf(wsId), path: atDir });
  }, [wsId, atDir, state.selfId]);
  const mentionWorld = useMentionWorld(channel);

  // Suggestions as you type: commands, people and Claudes, workspaces, folders.
  const suggestions: Suggestion[] = useMemo(
    () =>
      !buffer
        ? []
        : suggest(buffer, {
            peers: state.peers,
            selfId: state.selfId,
            dirCache: state.dirCache,
            listLocalDirs: (dir) => state.dirCache[localDirKey(dir)] ?? [],
            workspaces: state.view.kind === 'room' ? workspaceMentions(state.projects) : [],
            friends: state.network.friends,
            projects: state.projects.filter((p) => p.root),
            ...(wsId ? { entries: (dir: string) => state.dirCache[`${state.selfId}:${shareNameOf(wsId)}/${dir}`] } : {}),
          }),
    [buffer, state.peers, state.selfId, state.dirCache, state.view.kind, state.projects, state.network.friends, wsId],
  );
  const sug = useSuggestions(suggestions, buffer, (picked) => accept(picked));

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
    sug.reset();
  };
  /** The first message of a new worktree starts it (on the chosen branch, with the chosen name). */
  const createWorktree = (projectId: string, text: string): void => {
    const name = worktree.name.trim();
    void api.workspaces.startWorktree(projectId, text, { ...(worktree.base ? { base: worktree.base } : {}), ...(name ? { name } : {}) }).catch((err: unknown) => toast(client, `Couldn't create the worktree: ${errorText(err)}`, 'error'));
  };
  const deliver = (text: string, urgent: boolean): void => {
    if (draftProject && !text.startsWith('/')) return createWorktree(draftProject, text);
    if (to && !text.startsWith('/')) {
      ui.patch({ to: undefined });
      return actions.submit(`${recipientPrefix(to)}${text}`, urgent);
    }
    actions.submit(text, urgent);
  };
  const send = (urgent = false): void => {
    const typed = buffer.trim();
    const pictures = pendingImages;
    // Images stay where you referenced them in the words; any you took the reference out of go after them.
    const unplaced = pictures.filter((n) => !typed.includes(imageRef(n)));
    // Other files go as their paths (Claude reads them from this Mac).
    const others = typed.startsWith('/') ? [] : files;
    const text = (pictures.length || others.length) && !typed.startsWith('/') ? [typed, unplaced.map(imageRef).join(' '), others.map((f) => `\`${f.path}\``).join('\n')].filter(Boolean).join('\n\n') : typed;
    if (pictures.length && !typed.startsWith('/')) setImages([]);
    if (others.length) setFiles([]);
    if (!text && !(draftProject && worktree.name.trim())) {
      if (draftProject) toast(client, 'Describe the task, or give the worktree a name', 'info');
      return;
    }
    if (!text && draftProject) return createWorktree(draftProject, '');
    // The words fly from the box into the chat (or into the queue while Claude works): see flight.ts.
    if (typed && !typed.startsWith('/') && !draftProject && !pending) {
      launchFlight({ channel, target: compose.busy && compose.typing && !urgent ? 'queue' : 'chat', text: typed, from: ref.current });
      // Steering joins the turn Claude is on (no new card to wait for).
      if (compose.typing && !compose.busy) expectClaude(channel, state.log.filter((l) => l.type === 'agent' && l.channel === channel).length);
    }
    ui.patch({ buffer: '', cursor: 0, history: [...ui.get().history, typed].slice(-200), historyIndex: -1 });
    // Image chips become links to the images (klaud keeps them) before the message goes.
    if (text.includes('[image ') && !text.startsWith('/')) {
      api.attachments.expand(text, channel).then(
        (expanded) => deliver(expanded, urgent),
        (err: unknown) => {
          // Put the message and its images back so nothing is lost.
          if (!ui.get().buffer) ui.patch({ buffer: typed, cursor: typed.length });
          if (pictures.length) setImages(pictures);
          if (others.length) setFiles(others);
          toast(client, `Couldn't send the images: ${errorText(err)}`, 'error');
        },
      );
      return;
    }
    deliver(text, urgent);
  };
  const attach = async (files: readonly File[]): Promise<void> => {
    for (const file of files) {
      const ext = (/image\/(png|jpe?g|gif|webp)/.exec(file.type)?.[1] ?? 'png') as 'png' | 'jpg' | 'jpeg' | 'gif' | 'webp';
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      let added: { n: number; chip: string };
      try {
        added = await api.attachments.add(ext, btoa(bin));
        keepPreview(added.n, file);
      } catch (err) {
        toast(client, `Couldn't add ${file.name || 'the image'}: ${errorText(err)}`, 'error');
        continue;
      }
      setImages([...(waitingImages.get(channel) ?? []), added.n]);
      placeRef(added.n);
    }
  };
  /** Pasted paths of files on this Mac: images wait as thumbnails (referenced where the cursor was), others as chips. */
  const pastePaths = usePastePaths(ref, async (picked, at) => {
    const others = picked.filter((f) => !f.image);
    if (others.length) setFiles([...(waitingFiles.get(channel) ?? []), ...others.filter((f) => !(waitingFiles.get(channel) ?? []).some((w) => w.path === f.path))]);
    let cursor = at;
    for (const f of picked.filter((x) => x.image)) {
      try {
        const added = await api.attachments.addFile(f.path);
        const shown = await api.attachments.read(state.selfId, added.file);
        keepPreview(added.n, new Blob([Uint8Array.from(atob(shown.data), (c) => c.charCodeAt(0))], { type: shown.mime }));
        setImages([...(waitingImages.get(channel) ?? []), added.n]);
        cursor = placeRef(added.n, cursor);
      } catch (err) {
        toast(client, `Couldn't add ${f.name}: ${errorText(err)}`, 'error');
      }
    }
  });
  /** "[image N]" goes in the words where the cursor is (or `where`), so you can say what it shows. → where the cursor is after it. */
  const placeRef = (n: number, where?: number): number => {
    const now = ui.get().buffer;
    const el = ref.current;
    const at = Math.min(where ?? (el && document.activeElement === el ? el.selectionStart : now.length), now.length);
    const before = now.slice(0, at);
    const after = now.slice(at);
    const chip = `${before && !/\s$/.test(before) ? ' ' : ''}${imageRef(n)}${after && !/^\s/.test(after) ? ' ' : after ? '' : ' '}`;
    const next = before + chip + after;
    ui.patch({ buffer: next, cursor: before.length + chip.length });
    requestAnimationFrame(() => el?.setSelectionRange(before.length + chip.length, before.length + chip.length));
    return before.length + chip.length;
  };
  const imagesOf = (items: DataTransferItemList | undefined): File[] =>
    [...(items ?? [])].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter((f): f is File => Boolean(f));
  const [dropping, setDropping] = useState(false);
  /** Take an image out of the message. */
  const removeImage = (n: number): void => {
    setImages(images.filter((x) => x !== n));
    const now = ui.get().buffer;
    if (now.includes(imageRef(n))) ui.patch({ buffer: now.replace(` ${imageRef(n)}`, '').replace(imageRef(n), '') });
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
  function accept(picked: Suggestion): void {
    if (picked.enter === 'submit') {
      ui.patch({ buffer: '', cursor: 0 });
      actions.submit(picked.value);
      return;
    }
    set(picked.value);
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter while an input method is composing (Japanese, Chinese…) picks the characters.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Shift-Tab switches between acting and planning first, as in Claude Code (not focus).
    if (e.key === 'Tab' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && channel !== 'draft' && !shared && !planHome) {
      e.preventDefault();
      setMode(nextMode(mode));
      return;
    }
    const modKey = e.metaKey || e.ctrlKey;
    if (sug.onKeyDown(e)) return;
    if (e.key === 'Escape') {
      if (pending) ui.patch({ pending: undefined, buffer: '' });
      else if (to) ui.patch({ to: undefined });
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
      {sug.list}
      <QueueTray queue={queue} selfName={state.self?.name ?? ''} onEdit={editQueued} />
      <div
        className={cx(s.box, pending && s.asking, readOnly && s.readOnly, dropping && s.dropping, (plan || tasksMode) && s.planning)}
        data-plan={plan || tasksMode || undefined}
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
        {mode !== 'act' ? (
          <div className={s.planBanner} role="status">
            <Icon name={mode === 'tasks' ? 'graph' : 'wand'} size={11} />
            <strong>{mode === 'plan' ? 'Plan mode' : MODE_INFO[mode].label}</strong>
            <span>{MODE_INFO[mode].banner}</span>
            <span className={s.flex} />
            {mode === 'tasks' && homePlan ? (
              <button type="button" className={s.planLink} onClick={() => actions.run({ type: 'view', view: { kind: 'plan', id: homePlan.id } })}>
                Open Plan
              </button>
            ) : planHome ? null : (
              <span className={s.planKeys}>⇧⇥ to act</span>
            )}
          </div>
        ) : null}
        {draftProject ? <WorktreeDraft projectId={draftProject} choice={worktree} onChange={setWorktree} /> : null}
        {to ? (
          <div className={s.askChip} aria-label={`To ${recipientLabel(to)}`}>
            To {recipientLabel(to)}
            <button type="button" aria-label="Don’t address it" onClick={() => ui.patch({ to: undefined })}>
              <Icon name="x" size={10} />
            </button>
          </div>
        ) : null}
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
        {files.length ? (
          <div className={s.fileChips} role="list" aria-label="Files to send">
            {files.map((f) => (
              <span key={f.path} role="listitem" className={s.fileChip} title={f.path}>
                <Icon name="file" size={11} />
                <span className={s.fileName}>{f.name}</span>
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((x) => x.path !== f.path))}>
                  <Icon name="x" size={9} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className={s.inputWrap}>
          <MentionHighlighter text={buffer} world={mentionWorld} input={ref} className={s.input ?? ""} />
          <textarea
            ref={ref}
            className={`${s.input} ${s.overHighlight} selectable`}
            rows={1}
            value={buffer}
            disabled={readOnly}
            placeholder={to ? `Message ${recipientLabel(to)}` : mode === 'tasks' && homePlan && !homePlan.body && !homePlan.draft?.milestones.length ? 'Describe what to build: Claude plans it into milestones and tasks' : placeholderOf(state, pending ? { pending } : {})}
            onChange={(e) => set(e.target.value)}
            onKeyDown={onKey}
            onPaste={(e) => {
              const images = imagesOf(e.clipboardData.items);
              if (!images.length) return void pastePaths(e);
              e.preventDefault();
              void attach(images);
            }}
            spellCheck
          />
        </div>
        <div className={s.bar}>
          {planHome && homePlan ? (
            <ActionsDropdown
              align="start"
              items={[
                { label: 'Open the Plan', onSelect: () => actions.run({ type: 'view', view: { kind: 'plan', id: homePlan.id } }) },
                // While it's a draft nothing is on the board: it can go (asked first when it has something in it).
                ...(tasksMode ? [{ label: 'Discard the Draft', danger: true, separate: true, onSelect: () => setMode('act') }] : []),
              ]}
            >
              <button type="button" className={cx(s.chip, s.chipOn)} title="This conversation is the plan’s own: its Claude plans and runs it here" aria-label={`Mode: ${MODE_INFO.tasks.label}`}>
                <Icon name="graph" size={12} />
                {tasksMode ? MODE_INFO.tasks.label : 'Plan'}
                <Icon name="chevronDown" size={9} />
              </button>
            </ActionsDropdown>
          ) : channel !== 'draft' && !shared ? (
            <ActionsDropdown
              align="start"
              items={(['act', 'plan', 'tasks'] as const)
                .filter((m) => m !== 'tasks' || canPlanTasks || tasksMode)
                .map((m) => ({ label: MODE_INFO[m].label, hint: MODE_INFO[m].hint, checked: mode === m, onSelect: () => setMode(m) }))}
            >
              <button type="button" className={cx(s.chip, mode !== 'act' && s.chipOn)} title={mode === 'tasks' ? MODE_INFO[mode].hint : `${MODE_INFO[mode].hint} (⇧⇥ switches acting and planning first)`} aria-label={`Mode: ${MODE_INFO[mode].label}`}>
                <Icon name={mode === 'tasks' ? 'graph' : 'wand'} size={12} />
                {MODE_INFO[mode].label}
                <Icon name="chevronDown" size={9} />
              </button>
            </ActionsDropdown>
          ) : null}
          {!shared ? <ModelPicker channel={channel} /> : null}
          <span className={s.flex} />
          {channel !== 'draft' ? <ContextMeter channel={channel} /> : null}
          {compose.busy ? (
            <Tip label="Stop Claude here · your queued messages come back to the box" keys={`${mod()}.`}>
              <button type="button" className={s.stop} aria-label="Stop Claude" onClick={() => stopClaude({ client, ui, actions }, channel)}>
                <span className={s.stopMark} />
              </button>
            </Tip>
          ) : null}
          {draftProject ? (
            <Tip label={worktree.name.trim() && !buffer.trim() ? `Create ${worktree.name.trim()} without a task` : 'Make the branch and folder, then Claude starts on the task'} keys={sendKeys}>
              <button type="button" className={cx(d.create, canCreate && d.createReady)} onClick={() => send(false)} aria-disabled={!canCreate}>
                <Icon name="branch" size={12} />
                Create Worktree
                <span className={d.createKey}>{sendKeys}</span>
              </button>
            </Tip>
          ) : queueing ? (
            <div className={cx(s.split, buffer.trim() && s.splitReady)} role="group" aria-label="Claude is working">
              <Tip label="Claude is working: this waits its turn in the queue" keys={sendKeys}>
                <button type="button" className={s.splitMain} onClick={() => send(false)} disabled={!buffer.trim()}>
                  <Icon name="clock" size={12} />
                  Queue
                </button>
              </Tip>
              <Tip label="Steer: Claude reads this at its next step, without stopping" keys="⌥↩">
                <button type="button" className={s.splitAlt} onClick={() => send(true)} disabled={!buffer.trim()}>
                  Steer
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
      {/* Keys are shown only when they change what Return does (Mac apps don't keep a legend up). */}
      {queueing || draftProject ? (
      <div className={s.legend}>
        {queueing ? (
          <>
            <Kbd>{sendKeys}</Kbd> queue · <Kbd>⌥↩</Kbd> steer ·<Kbd>{mod()}.</Kbd> stop
          </>
        ) : (
          <>
            <Kbd>{sendKeys}</Kbd> create the worktree · <Kbd>esc</Kbd> cancel
          </>
        )}
      </div>
      ) : null}
    </div>
  );
}
