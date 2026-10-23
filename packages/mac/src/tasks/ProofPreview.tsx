import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';
import type { Location } from '@beluga/core/store.js';
import type { Proof } from '@beluga/core/board/model.js';
import { Icon } from '../components/Icon.js';
import { Button, IconButton, cx } from '../components/ui.js';
import { SCROLL_ROOT } from '../components/markdown/md-dom.js';
import { useActions } from '../lib/actions.js';
import { openWithDefaultApp } from '../lib/files.js';
import { useBeluga } from '../lib/beluga.js';
import { ChangedFileView } from '../views/ChangedFile.js';
import r from '../views/reader/reader.module.css';
import s from './proof-preview.module.css';

/**
 * A file a task kept as proof, read over the page you're on (a log, Markdown, code, a picture, a
 * PDF): it opens at once with "Opening…", and Show in Files (or ⌘-click on the proof) goes to the
 * Files view instead. Read on its own like a changed file, so the Files view's open file stays put.
 */

/** Load the reader ahead of the click (hovering a proof), so opening it is only reading the file. */
export const preloadReader = (): void => void import('../views/reader/FileReader.js');

export function ProofPreview({ proof, onClose }: { proof: Proof & { path: string }; onClose: () => void }) {
  const { client } = useBeluga();
  const actions = useActions();
  const [at, setAt] = useState<Location>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    client.api.session.localLocation(proof.path, false).then(
      (loc) => alive && setAt(loc),
      (err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      alive = false;
    };
  }, [client, proof.path]);
  const showInFiles = (): void => {
    onClose();
    actions.openLink({ kind: 'local', path: proof.path, dir: false });
  };
  return (
    <Dialog.Root open onOpenChange={(v) => (v ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.sheet} aria-describedby={undefined} onOpenAutoFocus={(e) => e.preventDefault()}>
          <header className={s.head}>
            <Icon name="file" size={14} />
            <div className={s.names}>
              <Dialog.Title className={s.title}>{proof.title}</Dialog.Title>
              <span className={s.path} title={proof.path}>
                {proof.path}
              </span>
            </div>
            <Button size="small" variant="quiet" icon="folder" onClick={showInFiles}>
              Show in Files
            </Button>
            <Button size="small" variant="quiet" icon="external" onClick={() => void openWithDefaultApp(client, proof.path)}>
              Open in Editor
            </Button>
            <Dialog.Close asChild>
              <IconButton icon="x" label="Close" keys="Esc" />
            </Dialog.Close>
          </header>
          <div className={cx(s.body, 'selectable')} tabIndex={0} role="region" aria-label={proof.title} {...{ [SCROLL_ROOT]: '' }}>
            {error ? <div className={r.opening}>Can’t open this file: {error}</div> : at ? <ChangedFileView at={at} variant="panel" version={proof.at} /> : <div className={r.opening}>Opening…</div>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
