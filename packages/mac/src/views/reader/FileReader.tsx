import { type MouseEvent, type ReactNode, useRef, useState } from 'react';
import type { ViewerState } from '@beluga/core/store.js';
import { formatBytes } from '@beluga/shared/format.js';
import { Icon } from '../../components/Icon.js';
import { Button, Empty, EmptyActions, IconButton, cx } from '../../components/ui.js';
import { CodeLines } from '../../components/markdown/CodeLines.js';
import { type DocNav, type DocVariant, MarkdownDoc } from '../../components/markdown/MarkdownDoc.js';
import { useImageUrl } from '../../components/markdown/MdImage.js';
import { MAX_FILE_BYTES } from '@beluga/protocol.js';
import { Bitmap } from '../FilesView.js';
import { isImageFile } from '../../components/markdown/md-paths.js';
import { BINARY_TEXT, LARGE_MARKDOWN, prettyJson, type ReaderMode, isMarkdownFile, isPdfFile, langOf } from './reader-model.js';
import { PdfView } from './PdfView.js';
import { usePinchZoom } from '../../components/usePinchZoom.js';
import r from './reader.module.css';

/**
 * One open file, read the right way: Markdown formatted (or as source), code with line numbers and
 * colors, images fitted to the window with zoom. The same in the focus view, the panel's preview
 * and the Files view; each brings its own header.
 */

function Notice({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className={r.notice} role="note">
      <Icon name="info" size={13} />
      <span className={r.noticeText}>{children}</span>
      {action}
    </div>
  );
}

const ZOOMS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

/**
 * An image as wide as the space it has (never blown up past its own size), so a tall one scrolls;
 * zoom in and out, or double-click for actual size. The original file is shown (sharp at any
 * zoom), not the small preview Beluga decoded for the terminal.
 */
function ImageView({ viewer, controls, version }: { viewer: ViewerState; controls: boolean; version?: string | number }) {
  const { url, error } = useImageUrl({ owner: viewer.owner, share: viewer.share, path: viewer.path }, version);
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const [natural, setNatural] = useState<{ w: number; h: number }>();
  const stage = useRef<HTMLDivElement>(null);
  // From "fit", zooming goes to the next step past the size it's fitted at.
  const fitted = (): number => {
    const el = stage.current;
    return el && natural ? Math.min(1, (el.clientWidth - 56) / natural.w) : 1;
  };
  // Two fingers on the trackpad zoom it too (anywhere it's shown: the reader, the panel, Changes, Scratch).
  usePinchZoom(stage, zoom === 'fit' ? fitted() : zoom, setZoom);
  const step = (dir: 1 | -1): void => {
    const now = zoom === 'fit' ? fitted() : zoom;
    const next = dir > 0 ? ZOOMS.find((z) => z > now + 0.001) : [...ZOOMS].reverse().find((z) => z < now - 0.001);
    if (next) setZoom(next);
  };
  const onDouble = (e: MouseEvent): void => {
    e.preventDefault();
    setZoom(zoom === 'fit' ? 1 : 'fit');
  };
  if (error && !viewer.image) return <Empty icon="alert" title="Can’t show this picture" detail={error} />;
  const sized = zoom !== 'fit' && natural ? { width: natural.w * zoom, height: natural.h * zoom, maxWidth: 'none' } : undefined;
  return (
    <div className={r.imageView}>
      <div ref={stage} className={cx(r.stage, zoom !== 'fit' && r.stageZoom)} onDoubleClick={onDouble}>
        {url ? (
          <img className={r.picture} src={url} alt={viewer.path} style={sized} onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} draggable={false} />
        ) : viewer.image ? (
          <Bitmap image={viewer.image} />
        ) : null}
      </div>
      {controls ? (
        <div className={r.zoomBar} role="toolbar" aria-label="Zoom">
          <IconButton icon="minus" label="Zoom out" onClick={() => step(-1)} />
          <button type="button" className={r.zoomValue} onClick={() => setZoom(zoom === 'fit' ? 1 : 'fit')} aria-label={zoom === 'fit' ? 'Actual size' : 'Fit to window'}>
            {zoom === 'fit' ? 'Fit' : `${Math.round(zoom * 100)}%`}
          </button>
          <IconButton icon="plus" label="Zoom in" onClick={() => step(1)} />
          {natural ? <span className={r.zoomSize}>{`${natural.w} × ${natural.h}`}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export interface FileContentProps {
  readonly viewer: ViewerState;
  readonly variant: DocVariant;
  readonly mode: ReaderMode;
  readonly onMode: (mode: ReaderMode) => void;
  /** Long lines wrap (code and Markdown source). */
  readonly wrap: boolean;
  /** Where the file is on this Mac, when it's yours (offers Open in Editor). */
  readonly onOpenInEditor?: (() => void) | undefined;
  readonly onSaveCopy?: (() => void) | undefined;
  readonly nav?: Partial<DocNav>;
  /** Changes when the file may have (a PDF is read again then). */
  readonly version?: unknown;
}

/** The file itself, under whatever header the place showing it has. */
export function FileContent({ viewer, variant, mode, onMode, wrap, onOpenInEditor, onSaveCopy, nav, version }: FileContentProps) {
  // PDFs and pictures are read as themselves (their bytes), whatever the text read made of them.
  if (isPdfFile(viewer.path)) return <PdfView at={{ owner: viewer.owner, share: viewer.share, path: viewer.path }} controls={variant !== 'panel'} version={version} />;
  if (viewer.image || (isImageFile(viewer.path) && !viewer.error)) return <ImageView viewer={viewer} controls={variant !== 'panel'} {...(typeof version === 'string' || typeof version === 'number' ? { version } : {})} />;
  if (viewer.loading && !viewer.content) return <div className={r.opening}>Opening…</div>;
  if (viewer.error) return <Empty icon="alert" title="Can’t open this file" detail={viewer.error} />;
  const escape = onOpenInEditor ? (
    <Button size="small" variant="quiet" icon="external" onClick={onOpenInEditor}>
      Open in Editor
    </Button>
  ) : onSaveCopy ? (
    <Button size="small" variant="quiet" icon="download" onClick={onSaveCopy}>
      Save a Copy…
    </Button>
  ) : undefined;
  if (viewer.content === BINARY_TEXT) {
    return <Empty icon="file" title="No preview for this kind of file" detail="It isn’t text, a picture or a PDF." action={escape ? <EmptyActions>{escape}</EmptyActions> : undefined} />;
  }
  const markdown = isMarkdownFile(viewer.path);
  const large = markdown && viewer.content.length > LARGE_MARKDOWN;
  const json = mode === 'rendered' ? prettyJson(viewer.path, viewer.content) : undefined;
  return (
    <div className={cx(r.content, r[`v_${variant}`])}>
      {viewer.truncated ? <Notice action={escape}>Only the first {formatBytes(MAX_FILE_BYTES)} of this file is shown.</Notice> : null}
      {large && mode === 'source' ? (
        <Notice
          action={
            <Button size="small" variant="quiet" onClick={() => onMode('rendered')}>
              Format It Anyway
            </Button>
          }
        >
          This file is large ({formatBytes(viewer.content.length)}), so it opens as source.
        </Notice>
      ) : null}
      {markdown && mode === 'rendered' ? (
        <MarkdownDoc text={viewer.content} at={viewer} variant={variant} {...(nav ? { nav } : {})} />
      ) : (
        <div className={r.codeFile}>
          <CodeLines text={json ?? viewer.content} lang={markdown ? 'markdown' : langOf(viewer.path)} numbers wrap={wrap || variant === 'panel'} />
        </div>
      )}
    </div>
  );
}
