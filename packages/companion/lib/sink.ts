import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';

/**
 * Where a fetched picture's pieces go as they come (BLG-106): on the phone, appended to a file in
 * the app's cache (each piece's base64 decoded natively), so a 20 MB Retina screenshot is never
 * one huge string in JavaScript and the image view reads it from disk (and animates a GIF). On the
 * web, and for small thumbnails, a data: URI. The cache is the OS's to clear.
 */
export interface Sink {
  add(b64: string): void;
  /** The URI to show, once every piece is in. */
  finish(mime: string): string;
  drop(): void;
}

const EXT: Readonly<Record<string, string>> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

/** Pieces kept as base64, for a data: URI. */
export function memorySink(): Sink {
  const parts: string[] = [];
  return {
    add: (b64) => void parts.push(b64),
    finish: (mime) => `data:${mime};base64,${parts.join('')}`,
    drop: () => void (parts.length = 0),
  };
}

let seq = 0;

/** Pieces appended to a cache file (a new name each fetch: the image view caches by URI). */
export function fileSink(ref: string, mime: string | undefined): Sink {
  if (Platform.OS === 'web') return memorySink();
  let file: File;
  try {
    const dir = new Directory(Paths.cache, 'beluga-pictures');
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    file = new File(dir, `${ref.replace(/[^A-Za-z0-9_-]/g, '_')}-${Date.now()}-${++seq}${EXT[mime ?? ''] ?? ''}`);
    file.create({ overwrite: true });
  } catch {
    return memorySink();
  }
  let broken = false;
  return {
    add: (b64) => {
      if (broken) return;
      try {
        file.writeSync(b64, { encoding: 'base64', append: true });
      } catch {
        broken = true;
      }
    },
    finish: () => {
      if (broken) throw new Error('Couldn’t keep the picture on the phone. Try again.');
      return file.uri;
    },
    drop: () => {
      try {
        if (file.exists) file.delete();
      } catch {
        // gone already
      }
    },
  };
}
