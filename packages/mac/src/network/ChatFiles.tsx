import { memo, useEffect, useState } from 'react';
import type { ChatFile, ChatFileState } from '@beluga/net/mesh/views.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { Icon } from '../components/Icon.js';
import { type ActionItem, ActionsContext } from '../components/SpecMenu.js';
import { cx } from '../components/ui.js';
import { inApp } from '../lib/boot.js';
import { copyText } from '../lib/copy.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { type Pending, removePending } from './attachments.js';
import { kindLabel, sizeLabel } from './chat-model.js';
import { useSay } from './use-net.js';
import s from './network.module.css';

/**
 * Files in a chat: cards with the file's state on this Mac (download it, watch it come, open it,
 * show it in Finder, save a copy), pictures shown inline, and the files waiting in the box.
 */

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Error: /, '');

/** Pictures already read from the store, by checksum (a data URL), so scrolling doesn't read them again. */
const previews = new Map<string, string>();

async function saveAs(client: SocketClient, f: ChatFile): Promise<string | undefined> {
  if (!inApp()) return undefined;
  const [{ save }, { downloadDir }] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/api/path')]);
  const dir = await downloadDir().catch(() => '');
  const to = await save({ title: `Save ${f.name}`, defaultPath: dir ? `${dir.replace(/\/+$/, '')}/${f.name}` : f.name });
  return to ? client.api.network['files.saveTo'](f.sha, to) : undefined;
}

function useFileState(sha: string): ChatFileState | undefined {
  return useApp((st) => st.network.files?.[sha]);
}

function fileItems(f: ChatFile, state: ChatFileState | undefined, ctx: { client: SocketClient; say: (t: string, level?: 'info' | 'success' | 'warn' | 'error') => void; conversation: string }): ActionItem[] {
  const { client, say } = ctx;
  const run = (what: Promise<unknown>, done?: string): void =>
    void what.then(
      () => done && say(done),
      (err) => say(errorText(err), 'error'),
    );
  if (state?.state !== 'here') {
    return [
      ...(state?.state === 'coming' ? [{ label: 'Stop Downloading', icon: 'stop' as const, onSelect: () => run(client.api.network['files.cancel'](f.sha)) }] : [{ label: 'Download', icon: 'download' as const, onSelect: () => run(client.api.network['files.download'](f.sha, ctx.conversation)) }]),
      { label: 'Copy Name', icon: 'copy', separate: true, onSelect: () => run(copyText(f.name), `Copied “${f.name}”`) },
    ];
  }
  return [
    { label: 'Open', icon: 'external', onSelect: () => run(client.api.network['files.open'](f.sha)) },
    { label: 'Show in Finder', icon: 'folder', onSelect: () => run(client.api.network['files.reveal'](f.sha)) },
    ...(inApp() ? [{ label: 'Save As…', icon: 'download' as const, onSelect: () => run(saveAs(client, f).then((to) => to && say(`Saved to ${to}`))) }] : []),
    { label: 'Copy Name', icon: 'copy', separate: true, onSelect: () => run(copyText(f.name), `Copied “${f.name}”`) },
    ...(state.path ? [{ label: 'Copy Path', onSelect: () => run(copyText(state.path!), 'Copied the path') }] : []),
  ];
}

/** A picture in the chat, read from the store once it's here. */
function Picture({ f, state }: { f: ChatFile; state: ChatFileState | undefined }) {
  const { client } = useBeluga();
  const [url, setUrl] = useState(() => previews.get(f.sha));
  const here = state?.state === 'here';
  useEffect(() => {
    if (!here || url) return;
    let alive = true;
    client.api.network['files.preview'](f.sha).then(
      (p) => {
        const data = `data:${p.mime};base64,${p.b64}`;
        previews.set(f.sha, data);
        if (alive) setUrl(data);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [here, url, f.sha]);
  if (!url) return null;
  return (
    <button type="button" className={s.picture} onClick={() => void client.api.network['files.open'](f.sha)} aria-label={`Open ${f.name}`}>
      <img src={url} alt={f.name} draggable={false} />
    </button>
  );
}

/** One file of a message. */
export const FileCard = memo(function FileCard({ f, conversation, mine }: { f: ChatFile; conversation: string; mine: boolean }) {
  const { client } = useBeluga();
  const say = useSay();
  const state = useFileState(f.sha);
  const here = state?.state === 'here';
  const coming = state?.state === 'coming';
  const pct = coming && state.size ? Math.min(100, Math.round(((state.received ?? 0) / state.size) * 100)) : 0;
  const fail = (err: unknown): void => say(errorText(err), 'error');
  const primary = (): void => {
    if (here) void client.api.network['files.open'](f.sha).catch(fail);
    else if (!coming) void client.api.network['files.download'](f.sha, conversation).catch(fail);
  };
  const detail = coming
    ? state.error && !state.received
      ? state.error
      : `${sizeLabel(state.received ?? 0)} of ${sizeLabel(f.size)}`
    : state?.state === 'failed'
      ? (state.error ?? 'Didn’t come')
      : here
        ? `${kindLabel(f)} · ${sizeLabel(f.size)}`
        : `${kindLabel(f)} · ${sizeLabel(f.size)} · ${mine ? 'sent' : 'not downloaded'}`;
  return (
    <ActionsContext items={() => fileItems(f, state, { client, say, conversation })}>
      <div className={s.fileWrap} data-file={f.sha}>
        {f.image ? <Picture f={f} state={state} /> : null}
        <div className={cx(s.file, state?.state === 'failed' && s.fileFailed)} role="group" aria-label={`${f.name}, ${detail}`}>
          <button type="button" className={s.fileMain} onClick={primary} title={here ? `Open ${f.name}` : coming ? undefined : `Download ${f.name}`}>
            <span className={s.fileIcon}>
              <Icon name={f.image ? 'image' : 'file'} size={16} />
            </span>
            <span className={s.fileText}>
              <span className={s.fileName}>{f.name}</span>
              <span className={s.fileDetail}>{detail}</span>
            </span>
          </button>
          {coming ? (
            <button type="button" className={s.fileAction} aria-label={`Stop downloading ${f.name}`} onClick={() => void client.api.network['files.cancel'](f.sha).catch(fail)}>
              <Icon name="x" size={11} />
            </button>
          ) : here ? (
            <button type="button" className={s.fileAction} aria-label={`Show ${f.name} in Finder`} onClick={() => void client.api.network['files.reveal'](f.sha).catch(fail)}>
              <Icon name="folder" size={12} />
            </button>
          ) : (
            <button type="button" className={s.fileAction} aria-label={state?.state === 'failed' ? `Try downloading ${f.name} again` : `Download ${f.name}`} onClick={() => void client.api.network['files.download'](f.sha, conversation).catch(fail)}>
              <Icon name={state?.state === 'failed' ? 'refresh' : 'download'} size={12} />
            </button>
          )}
          {coming ? (
            <span className={s.fileBar} aria-hidden="true">
              <span style={{ width: `${pct}%` }} />
            </span>
          ) : null}
        </div>
      </div>
    </ActionsContext>
  );
});

/** The files of a message, in a row that wraps. */
export function MessageFiles({ files, conversation, mine }: { files: readonly ChatFile[]; conversation: string; mine: boolean }) {
  return (
    <div className={s.files}>
      {files.map((f) => (
        <FileCard key={f.sha} f={f} conversation={conversation} mine={mine} />
      ))}
    </div>
  );
}

/** Files waiting in the message box: a chip each, with its state and a way to take it out. */
export function PendingTray({ id, items }: { id: string; items: readonly Pending[] }) {
  if (!items.length) return null;
  return (
    <div className={s.tray} role="list" aria-label="Files to send">
      {items.map((p) => (
        <span key={p.key} role="listitem" className={cx(s.trayItem, p.state === 'failed' && s.trayFailed)} title={p.error ?? p.name}>
          {p.thumb ? <img src={p.thumb} alt="" className={s.trayThumb} /> : <Icon name={p.state === 'failed' ? 'alert' : 'file'} size={12} />}
          <span className={s.trayName}>{p.name}</span>
          <span className={s.traySize}>{p.state === 'adding' ? 'Preparing…' : p.state === 'failed' ? (p.error ?? 'Couldn’t add it') : p.file ? sizeLabel(p.file.size) : ''}</span>
          <button type="button" aria-label={`Remove ${p.name}`} onClick={() => removePending(id, p.key)}>
            <Icon name="x" size={9} />
          </button>
        </span>
      ))}
    </div>
  );
}
