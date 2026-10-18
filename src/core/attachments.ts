import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, promises as fs, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { klaudHome } from './home.js';

/**
 * Images pasted into the box you type in. Each becomes a chip like "[image 1]" in the
 * text; the file is saved under ~/.klaud/attachments. On send, chips turn into links
 * ("📎 image 1 (png, 120K)") that open the image, and your own Claude gets the pixels.
 */

/** The private share friends fetch room images from (only copies of images sent to the room). */
export const ATTACHMENT_SHARE = 'klaud-attachments';
/** Link scheme for an image in a chat message: klaud-attachment:<owner peer id>/<file name>. */
export const ATTACHMENT_SCHEME = 'klaud-attachment:';
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
/** Biggest image accepted (the Claude API takes up to 5 MB per image once base64-encoded, a third bigger). */
export const MAX_ATTACHMENT_BYTES = Math.floor(3.7 * 1024 * 1024);

export const attachmentsDir = (): string => path.join(klaudHome(), 'attachments');
/** Copies of images sent to the room, the only ones friends can fetch. */
export const roomAttachmentsDir = (): string => path.join(attachmentsDir(), 'room');

export interface Attachment {
  readonly n: number;
  readonly path: string;
  readonly size: number;
}

// Chips in the box map to files here (numbers keep counting up for the whole session).
const registry = new Map<number, Attachment>();
let counter = 0;

export function registerAttachment(file: string, size: number): Attachment {
  const a = { n: ++counter, path: file, size };
  registry.set(a.n, a);
  return a;
}

export const attachment = (n: number): Attachment | undefined => registry.get(n);
export const chipText = (n: number): string => `[image ${n}]`;
const CHIP = /\[image (\d+)\]/g;

/** Insert text at the cursor, with a space on each side where needed. */
export function insertChip(buffer: string, cursor: number, chip: string): { buffer: string; cursor: number } {
  const before = buffer.slice(0, cursor);
  const after = buffer.slice(cursor);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const text = `${lead}${chip} `;
  return { buffer: before + text + after.replace(/^ /, ''), cursor: cursor + text.length };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

/** The label shown in the chat for an image. */
export const attachmentLabel = (a: Attachment): string => `📎 image ${a.n} (${path.extname(a.path).slice(1).toLowerCase() || 'image'}, ${formatBytes(a.size)})`;

/**
 * Replace "[image N]" chips with Markdown links to the images. `publish` is told about each
 * image (to make it available to the room) and returns the file name to link to.
 */
export function expandChips(text: string, selfId: string, publish: (a: Attachment) => string = (a) => path.basename(a.path)): { text: string; attachments: Attachment[] } {
  const used: Attachment[] = [];
  const out = text.replace(CHIP, (chip, n: string) => {
    const a = registry.get(Number(n));
    if (!a) return chip;
    used.push(a);
    return `[${attachmentLabel(a)}](${ATTACHMENT_SCHEME}${selfId}/${publish(a)})`;
  });
  return { text: out, attachments: used };
}

/** Images on this computer linked from a prompt (only files in the attachments folder count). */
export function linkedImages(prompt: string, dir = attachmentsDir()): string[] {
  const out: string[] = [];
  for (const m of prompt.matchAll(/klaud-attachment:[^/\s)]+\/([^/\s)]+)/g)) {
    const name = m[1] ?? '';
    if (!IMAGE_EXT.test(name) || name.startsWith('.')) continue;
    for (const where of [dir, path.join(dir, 'room')]) {
      const abs = path.join(where, name);
      try {
        if (statSync(abs).isFile() && !out.includes(abs)) {
          out.push(abs);
          break;
        }
      } catch {
        // not here
      }
    }
  }
  return out;
}

export const mediaTypeOf = (file: string): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' => {
  const ext = path.extname(file).toLowerCase();
  return ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/png';
};

const stamp = (): string => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-') + `-${Math.random().toString(36).slice(2, 6)}`;

const run = (cmd: string, args: readonly string[]): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    execFile(cmd, [...args], { encoding: 'buffer', timeout: 15_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

const isPng = (b: Buffer): boolean => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/**
 * Save the image on the clipboard (if there is one) in the attachments folder. macOS: an image
 * file copied in Finder is copied over as is, else AppleScript hands over the clipboard as PNG
 * (screenshots, images copied from a browser or Preview). Linux uses wl-paste or xclip.
 */
export async function saveClipboardImage(dir = attachmentsDir()): Promise<string | undefined> {
  await fs.mkdir(dir, { recursive: true });
  if (process.platform === 'darwin') return (await copiedImageFile(dir)) ?? (await macClipboardPng(dir));
  if (process.platform === 'linux') {
    const file = path.join(dir, `${stamp()}.png`);
    for (const [cmd, args] of [['wl-paste', ['--type', 'image/png']], ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']]] as const) {
      try {
        const bytes = await run(cmd, args);
        if (!isPng(bytes)) continue;
        await fs.writeFile(file, bytes);
        return file;
      } catch {
        // try the next tool
      }
    }
  }
  return undefined;
}

/** An image file copied in Finder (the clipboard holds its location, plus only its icon as a picture). */
async function copiedImageFile(dir: string): Promise<string | undefined> {
  let copied: string;
  try {
    copied = (await run('osascript', ['-e', 'POSIX path of (the clipboard as «class furl»)'])).toString('utf8').trim();
  } catch {
    return undefined; // no file on the clipboard
  }
  // Plain text coerces to a made-up path ("hello" → "/hello"), so it must really be a file.
  if (!isFile(copied)) return undefined;
  // Another kind of file: its only picture is its icon, which isn't what you meant.
  if (!IMAGE_EXT.test(copied)) throw new Error(`${path.basename(copied)} isn't an image (png, jpg, gif or webp)`);
  return importImage(copied, dir);
}

async function macClipboardPng(dir: string): Promise<string | undefined> {
  const file = path.join(dir, `${stamp()}.png`);
  const target = file.replace(/["\\]/g, '\\$&');
  try {
    await run('osascript', [
      '-e', 'set png_data to (the clipboard as «class PNGf»)',
      '-e', `set fp to open for access POSIX file "${target}" with write permission`,
      '-e', 'write png_data to fp',
      '-e', 'close access fp',
    ]);
  } catch {
    await fs.rm(file, { force: true });
    return undefined; // no image on the clipboard
  }
  const size = statSync(file).size;
  return size > MAX_ATTACHMENT_BYTES ? shrinkImage(file) : size > 0 ? file : undefined;
}

/**
 * Big screenshots (a full Retina screen can pass the limit) become a smaller JPEG. Claude
 * scales images down to about 1568 pixels on the long side anyway.
 */
async function shrinkImage(file: string): Promise<string> {
  const out = file.replace(/\.png$/, '.jpg');
  try {
    for (const [edge, quality] of [['2000', '80'], ['1568', '60']] as const) {
      await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', quality, '-Z', edge, file, '--out', out]);
      if (statSync(out).size <= MAX_ATTACHMENT_BYTES) return out;
    }
  } finally {
    await fs.rm(file, { force: true });
  }
  await fs.rm(out, { force: true });
  throw new Error(`the image is too big (up to ${formatBytes(MAX_ATTACHMENT_BYTES)})`);
}

/**
 * Text pasted by dragging files into the terminal: one or more paths, maybe quoted,
 * with escaped spaces, or file:// URLs. Returns them only if every one is an image file.
 */
/** decodeURIComponent that never throws (a pasted "%zz" would otherwise crash the input handler). */
const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export function droppedImagePaths(text: string, exists: (p: string) => boolean = isFile): string[] | undefined {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 4000) return undefined;
  const tokens: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|((?:\\.|[^\s\\])+)/g;
  for (const m of trimmed.matchAll(re)) tokens.push(m[1] ?? m[2] ?? (m[3] ?? '').replace(/\\(.)/g, '$1'));
  if (!tokens.length) return undefined;
  const paths = tokens.map((t) => {
    const p = t.startsWith('file://') ? safeDecode(t.slice(7)) : t;
    return p.replace(/^~(?=$|\/)/, os.homedir());
  });
  return paths.every((p) => path.isAbsolute(p) && IMAGE_EXT.test(p) && exists(p)) ? paths : undefined;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Copy an image file into the attachments folder (so the link keeps working if the original moves). */
export async function importImage(src: string, dir = attachmentsDir()): Promise<string> {
  const size = statSync(src).size;
  if (size > MAX_ATTACHMENT_BYTES) throw new Error(`${path.basename(src)} is too big (${formatBytes(size)}; up to ${formatBytes(MAX_ATTACHMENT_BYTES)})`);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${stamp()}${path.extname(src).toLowerCase()}`);
  await fs.copyFile(src, file);
  return file;
}

/** Put a copy where friends can fetch it; returns the file name to link to. */
export function publishForRoom(a: Attachment, dir = roomAttachmentsDir()): string {
  const name = path.basename(a.path);
  mkdirSync(dir, { recursive: true });
  copyFileSync(a.path, path.join(dir, name));
  return name;
}
