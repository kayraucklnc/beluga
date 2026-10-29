import { useEffect, useMemo, useState } from 'react';
import { documentLook, quietHtml, sizeWords } from '@beluga/core/sentinel/columns.js';
import { FormSheet } from '../components/FormSheet.js';
import { Button } from '../components/ui.js';
import { useApi } from '../lib/beluga.js';
import { useSentinelActions } from './use-sentinel.js';
import n from './numbers.module.css';

type Doc = Awaited<ReturnType<ReturnType<typeof useApi>['sentinel']['document']>>;

/**
 * A kept table's document (BLG-381), in Beluga's quiet viewer: a page with nothing allowed to run or
 * load (no scripts, no network: its policy first, and a sandbox with nothing allowed), text as text,
 * a picture as a picture; anything else by its name and size. Open in Default App beside it.
 */
export function DocumentSheet({ sentinelId, metric, column, name, close }: { sentinelId: string; metric: string; column: string; name: string; close: () => void }) {
  const api = useApi();
  const a = useSentinelActions();
  const [doc, setDoc] = useState<Doc>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    api.sentinel.document(sentinelId, metric, column, name).then(
      (d) => alive && setDoc(d),
      (err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      alive = false;
    };
  }, [sentinelId, metric, column, name]);
  const look = doc ? documentLook(doc.mime) : undefined;
  // A PDF from its bytes, while the sheet is open.
  const pdf = useMemo(() => (doc?.base64 && look === 'pdf' ? URL.createObjectURL(new Blob([Uint8Array.from(atob(doc.base64), (c) => c.charCodeAt(0))], { type: doc.mime })) : undefined), [doc, look]);
  useEffect(() => () => (pdf ? URL.revokeObjectURL(pdf) : undefined), [pdf]);
  const open = (): void => void a.act(() => api.sentinel.documentOpen(sentinelId, metric, column, name));
  return (
    <FormSheet
      title={name}
      icon="file"
      submitLabel="Close"
      hideSubmit
      cancelLabel="Close"
      width={820}
      onSubmit={close}
      onCancel={close}
      footer={
        <Button size="small" icon="external" onClick={open}>
          Open in Default App
        </Button>
      }
    >
      <div className={n.docView} data-look={look ?? 'wait'}>
        {error ? (
          <p className={n.docNote}>{error}</p>
        ) : !doc ? (
          <p className={n.docNote}>Loading…</p>
        ) : look === 'html' && doc.text !== undefined ? (
          <iframe className={n.docFrame} title={name} sandbox="" srcDoc={quietHtml(doc.text)} referrerPolicy="no-referrer" />
        ) : look === 'image' ? (
          <img className={n.docImage} alt={name} src={doc.base64 ? `data:${doc.mime};base64,${doc.base64}` : `data:${doc.mime};charset=utf-8,${encodeURIComponent(doc.text ?? '')}`} />
        ) : look === 'pdf' && pdf ? (
          <iframe className={n.docFrame} title={name} src={pdf} />
        ) : look === 'text' && doc.text !== undefined ? (
          <pre className={n.docText}>{doc.text}</pre>
        ) : (
          <p className={n.docNote}>
            {name} · {sizeWords(doc.size)}. Beluga doesn’t show this kind of file: open it in its app.
          </p>
        )}
        {doc?.cut ? <p className={n.docNote}>Only the start is shown here.</p> : null}
      </div>
    </FormSheet>
  );
}
