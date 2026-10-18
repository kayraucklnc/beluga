import * as Dialog from '@radix-ui/react-dialog';
import type { LinkedImage } from '@klaud/shared/attachment-links.js';
import { Icon } from '../components/Icon.js';
import { Button, Kbd, Tip, cx } from '../components/ui.js';
import { toast, useApi, useKlaud } from '../lib/klaud.js';
import { mod } from '../lib/system.js';
import { closeLightbox, copyImage, loadImage, openLightbox, stepLightbox, useImage, useLightbox } from './images.js';
import s from './images.module.css';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** One image in a message: a thumbnail that opens full size. */
function Thumb({ image, all, index, tiled }: { image: LinkedImage; all: readonly LinkedImage[]; index: number; tiled: boolean }) {
  const api = useApi();
  const state = useImage(api, image);
  const name = `${image.label}${image.detail ? ` (${image.detail})` : ''}`;
  if (state.status === 'error') {
    return (
      <div className={cx(s.thumb, s.failed, tiled && s.tile)} role="img" aria-label={`${name}: unavailable`} title={state.error}>
        <Icon name="alert" size={14} />
        <span>Image unavailable</span>
      </div>
    );
  }
  return (
    <button type="button" className={cx(s.thumb, tiled && s.tile, state.status === 'loading' && s.loading)} aria-label={`Open ${name}`} onClick={() => openLightbox(all, index)} disabled={state.status !== 'ready'}>
      {state.status === 'ready' ? <img src={state.url} alt={name} draggable={false} /> : null}
    </button>
  );
}

/** The images a message links to: one keeps its shape, several sit in a neat grid. */
export function ImageGrid({ images }: { images: readonly LinkedImage[] }) {
  if (!images.length) return null;
  const tiled = images.length > 1;
  return (
    <div className={cx(s.grid, tiled && s.gridMany, images.length === 2 && s.gridTwo)}>
      {images.map((img, i) => (
        <Thumb key={img.href} image={img} all={images} index={i} tiled={tiled} />
      ))}
    </div>
  );
}

function Full({ image }: { image: LinkedImage }) {
  const api = useApi();
  const state = useImage(api, image);
  if (state.status === 'ready') return <img className={s.full} src={state.url} alt={image.label} draggable={false} onClick={(e) => e.stopPropagation()} />;
  return <div className={cx(s.fullPending, state.status === 'error' && s.failed)}>{state.status === 'error' ? `Image unavailable: ${state.error}` : null}</div>;
}

/** An image full size: Esc or a click outside closes, ⌘C copies it, Open shows it in Preview. */
export function Lightbox() {
  const { client } = useKlaud();
  const api = useApi();
  const box = useLightbox();
  const image = box?.images[box.index];
  if (!box || !image) return null;
  const many = box.images.length > 1;
  const copy = async (): Promise<void> => {
    try {
      await copyImage(await loadImage(api, image));
      toast(client, 'Copied the image', 'success');
    } catch (err) {
      toast(client, `Couldn't copy the image: ${errorText(err)}`, 'error');
    }
  };
  const openInPreview = (): void => {
    api.attachments.open(image.owner, image.file).catch((err: unknown) => toast(client, `Couldn't open the image: ${errorText(err)}`, 'error'));
  };
  return (
    <Dialog.Root open onOpenChange={(v) => (v ? undefined : closeLightbox())}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content
          className={s.lightbox}
          aria-describedby={undefined}
          // Focus the lightbox itself (not its first button, which would pop a tooltip that eats Esc).
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
          onClick={closeLightbox}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'c' && !window.getSelection()?.toString()) {
              e.preventDefault();
              void copy();
            } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault();
              stepLightbox(e.key === 'ArrowRight' ? 1 : -1);
            }
          }}
        >
          <div className={s.bar} onClick={(e) => e.stopPropagation()}>
            <Dialog.Title className={s.title}>
              {image.label}
              {image.detail ? <span className={s.detail}>{image.detail}</span> : null}
              {many ? <span className={s.detail}>{`${box.index + 1} of ${box.images.length}`}</span> : null}
            </Dialog.Title>
            {many ? (
              <>
                <Tip label="Previous image" keys="←">
                  <Button size="small" variant="quiet" icon="back" aria-label="Previous image" onClick={() => stepLightbox(-1)} />
                </Tip>
                <Tip label="Next image" keys="→">
                  <Button size="small" variant="quiet" icon="forward" aria-label="Next image" onClick={() => stepLightbox(1)} />
                </Tip>
              </>
            ) : null}
            <Tip label="Copy the image" keys={`${mod()}C`}>
              <Button size="small" variant="quiet" icon="copy" onClick={() => void copy()}>
                Copy
              </Button>
            </Tip>
            <Tip label="Open in Preview">
              <Button size="small" variant="quiet" icon="share" onClick={openInPreview}>
                Open
              </Button>
            </Tip>
            <Dialog.Close className={s.close} aria-label="Close">
              <Icon name="x" size={12} />
            </Dialog.Close>
          </div>
          <div className={s.stage}>
            <Full image={image} />
          </div>
          <div className={s.hint}>
            <Kbd>esc</Kbd> close · <Kbd>{mod()}C</Kbd> copy{many ? ' · ← → more' : ''}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
