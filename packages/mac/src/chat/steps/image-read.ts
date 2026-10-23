/**
 * A step that reads a picture ("Read shots/home.png", "Reading /Users/…/Shot 1.heic"): the row
 * shows the verb and the file's name as a badge, not its whole path. Plain data, tested on its own.
 */

/** Files that are pictures, by their extension. */
export const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|svg|bmp|heic|heif|tiff?|avif|ico)$/i;

export interface ImageRead {
  /** "Read" or "Reading", as the step's words say it. */
  readonly verb: string;
  /** The file's name with its extension ("home.png"). */
  readonly name: string;
  /** The path as the words gave it (for a tooltip). */
  readonly path: string;
}

/**
 * The picture a step reads, from its tool and words, or undefined when it reads something else
 * (or isn't a read). A one-line step from someone else's Claude has no tool: its words say "Read".
 */
export function imageReadOf(step: { readonly kind: string; readonly tool?: string | undefined }, words: string): ImageRead | undefined {
  if (step.kind !== 'tool' || (step.tool !== undefined && step.tool !== 'Read')) return undefined;
  const m = /^(Read|Reading)\s+(.+)$/.exec(words.trim());
  if (!m) return undefined;
  const path = m[2]!.trim().replace(/^[`'"]|[`'"]$/g, '');
  if (!IMAGE_FILE.test(path)) return undefined;
  const name = path.replace(/\/+$/, '').split('/').pop() ?? path;
  return name ? { verb: m[1]!, name, path } : undefined;
}
