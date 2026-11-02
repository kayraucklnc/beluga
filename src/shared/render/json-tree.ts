/**
 * A ```json block (or JSONC, with comments and trailing commas) read as a value the screens draw
 * as a tree that folds: keys, strings, numbers, true/false and null each in their color, every
 * object and array with how much it holds. Text that doesn't read as JSON stays code. Pure.
 */

export type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };

export interface JsonDoc {
  readonly value: Json;
  /** Two-space indented, for copying "beautified". */
  readonly pretty: string;
  /** Whether the text was already laid out over lines (else it's shown beautified from the start). */
  readonly laidOut: boolean;
  readonly nodes: number;
}

export const JSON_FENCE = /^(json|jsonc|json5|geojson|jsonl?|webmanifest|har)$/;
const MAX_TEXT = 400_000;

/** Comments and trailing commas out, strings left alone (JSONC → JSON). */
function stripJsonc(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function count(v: Json): number {
  if (v === null || typeof v !== 'object') return 1;
  return 1 + (Array.isArray(v) ? v : Object.values(v)).reduce<number>((n, x) => n + count(x as Json), 0);
}

/** The JSON in a block, or undefined when it isn't JSON (or is a lone number or word). */
export function readJson(text: string): JsonDoc | undefined {
  const t = text.trim();
  if (!t || t.length > MAX_TEXT || !/^[[{]/.test(t)) return undefined;
  let value: Json;
  try {
    value = JSON.parse(t) as Json;
  } catch {
    try {
      value = JSON.parse(stripJsonc(t)) as Json;
    } catch {
      return undefined;
    }
  }
  return { value, pretty: JSON.stringify(value, null, 2), laidOut: t.includes('\n'), nodes: count(value) };
}

/** What a folded object or array holds, in words ("3 keys", "12 items"). */
export function jsonSize(v: Json): string {
  if (Array.isArray(v)) return `${v.length} ${v.length === 1 ? 'item' : 'items'}`;
  if (v && typeof v === 'object') {
    const n = Object.keys(v).length;
    return `${n} ${n === 1 ? 'key' : 'keys'}`;
  }
  return '';
}

/** A key as a path step: `.name`, or `["odd key"]`, or `[3]`. */
export function pathStep(key: string | number): string {
  if (typeof key === 'number') return `[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

/** A short preview of what's inside a folded object or array (`{ id, name, … }`, `[1, 2, …]`). */
export function jsonPreview(v: Json, max = 48): string {
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (const x of v) {
      const s = x !== null && typeof x === 'object' ? (Array.isArray(x) ? '[…]' : '{…}') : JSON.stringify(x);
      if (parts.join(', ').length + s.length > max) {
        parts.push('…');
        break;
      }
      parts.push(s);
    }
    return `[${parts.join(', ')}]`;
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    const parts: string[] = [];
    for (const k of keys) {
      if (parts.join(', ').length + k.length > max) {
        parts.push('…');
        break;
      }
      parts.push(k);
    }
    return `{ ${parts.join(', ')} }`;
  }
  return JSON.stringify(v);
}

/** How deep a document opens at first: everything when it's small, the top levels when it's big. */
export function openDepth(doc: JsonDoc): number {
  return doc.nodes <= 60 ? 99 : doc.nodes <= 400 ? 2 : 1;
}
