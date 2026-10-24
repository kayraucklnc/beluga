import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type ProjectIcon, readProjectIcon } from '../core/project-icons.js';

/**
 * Projects' icons for the phone (BLG-45): the icon the Mac shows next to a project (yours, else the
 * one the project ships, src/core/project-icons.ts), made small (a PNG of at most ICON_PX on its
 * longest side, with `sips`) and named by its checksum. Views carry only the checksum
 * (`icon`); the phone fetches an icon once with `companion.icon(sum)` and keeps it by that sum, so
 * a project whose icon didn't change is never fetched again.
 *
 * Made in the background the first time a view asks, never on the view's path: until it's made, a
 * view has no `icon` (the phone draws the project's initial), and the views go again when it is.
 */

/** The icon's longest side on the phone (it's drawn at 28-40 pt, so 128 px is sharp at 3×). */
export const ICON_PX = 128;
/** An SVG goes as it is (the phone draws it) when it's at most this big; a bigger one isn't sent. */
const MAX_SVG = 64 * 1024;
/** How long an icon is trusted before it's looked up again (you may pick another one on the Mac). */
const TTL_MS = 10 * 60_000;

export interface SmallIcon {
  readonly sum: string;
  readonly mime: string;
  readonly b64: string;
}

/** Makes `dest` a PNG of `src` at most `px` on its longest side. */
export type Shrinker = (src: string, dest: string, px: number) => Promise<void>;

export const sipsShrinker: Shrinker = (src, dest, px) =>
  new Promise((resolve, reject) => {
    execFile('sips', ['-Z', String(px), '-s', 'format', 'png', src, '--out', dest], { timeout: 20_000 }, (err) => (err ? reject(new Error('Could not make the icon small')) : resolve()));
  });

const EXT: Readonly<Record<string, string>> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/x-icon': '.ico' };

export interface ProjectIconsOptions {
  /** Where small icons are made (~/.beluga/companion/icons). */
  readonly dir: string;
  /** A project's folder, by its id. */
  readonly root: (projectId: string) => string | undefined;
  /** An icon was made: views that show it are due. */
  readonly changed: () => void;
  readonly read?: (root: string) => ProjectIcon | undefined;
  readonly shrink?: Shrinker;
  readonly now?: () => number;
}

interface Entry {
  readonly at: number;
  readonly icon?: SmallIcon;
}

export class ProjectIcons {
  private readonly byProject = new Map<string, Entry>();
  private readonly bySum = new Map<string, SmallIcon>();
  private readonly making = new Set<string>();

  constructor(private readonly opts: ProjectIconsOptions) {}

  /** The checksum of a project's small icon, if it has one and it's been made (else it's made now, in the background). */
  sumFor(projectId: string): string | undefined {
    const now = (this.opts.now ?? Date.now)();
    const known = this.byProject.get(projectId);
    if (!known || now - known.at > TTL_MS) this.make(projectId);
    return known?.icon?.sum;
  }

  /** A small icon by its checksum: only ones handed out in a view. */
  get(sum: string): SmallIcon | undefined {
    return this.bySum.get(sum);
  }

  private make(projectId: string): void {
    if (this.making.has(projectId)) return;
    const root = this.opts.root(projectId);
    if (!root) return;
    this.making.add(projectId);
    void this.small(root)
      .catch(() => undefined)
      .then((icon) => {
        const was = this.byProject.get(projectId)?.icon?.sum;
        this.byProject.set(projectId, { at: (this.opts.now ?? Date.now)(), ...(icon ? { icon } : {}) });
        if (icon) this.bySum.set(icon.sum, icon);
        if (icon?.sum !== was) this.opts.changed();
      })
      .finally(() => this.making.delete(projectId));
  }

  private async small(root: string): Promise<SmallIcon | undefined> {
    const found = (this.opts.read ?? readProjectIcon)(root);
    if (!found) return undefined;
    const bytes = Buffer.from(found.data, 'base64');
    if (found.mime === 'image/svg+xml') return bytes.length <= MAX_SVG ? iconOf('image/svg+xml', bytes) : undefined;
    const ext = EXT[found.mime];
    if (!ext) return undefined;
    const key = createHash('sha256').update(bytes).digest('hex').slice(0, 24);
    mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
    const src = path.join(this.opts.dir, `${key}-src${ext}`);
    const dest = path.join(this.opts.dir, `${key}.png`);
    let png: Buffer | undefined;
    try {
      png = readFileSync(dest);
    } catch {
      writeFileSync(src, bytes, { mode: 0o600 });
      await (this.opts.shrink ?? sipsShrinker)(src, dest, ICON_PX);
      png = readFileSync(dest);
    }
    return png.length ? iconOf('image/png', png) : undefined;
  }
}

const iconOf = (mime: string, bytes: Buffer): SmallIcon => ({ sum: createHash('sha256').update(bytes).digest('hex').slice(0, 32), mime, b64: bytes.toString('base64') });
