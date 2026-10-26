import { floatsToHex } from './look.js';

/**
 * The file formats other terminals keep their settings in, read just far enough for their look:
 * property lists (binary and XML, and the keyed archives Terminal keeps its colours and font in),
 * and small TOML and YAML readers. Pure: they take the text or bytes and never throw on junk
 * (a bad file is simply nothing to bring).
 */

/** A plist's UID (keyed archives point at their objects with these). */
export interface Uid {
  readonly UID: number;
}
export type Plist = string | number | boolean | Date | Uint8Array | Uid | null | readonly Plist[] | { readonly [key: string]: Plist };

const isUid = (v: unknown): v is Uid => typeof v === 'object' && v !== null && !(v instanceof Uint8Array) && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as Uid).UID === 'number';

export const asDict = (v: unknown): Record<string, Plist> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array) && !(v instanceof Date) ? (v as Record<string, Plist>) : undefined);

// ---- binary plists (bplist00)

/** A binary property list → its value, or undefined if it isn't one. */
export function parseBplist(bytes: Uint8Array): Plist | undefined {
  try {
    if (bytes.length < 40 || String.fromCharCode(...bytes.subarray(0, 8)) !== 'bplist00') return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const t = bytes.length - 32;
    const offSize = bytes[t + 6]!;
    const refSize = bytes[t + 7]!;
    const count = Number(view.getBigUint64(t + 8));
    const top = Number(view.getBigUint64(t + 16));
    const table = Number(view.getBigUint64(t + 24));
    const uint = (at: number, size: number): number => {
      let n = 0;
      for (let i = 0; i < size; i++) n = n * 256 + bytes[at + i]!;
      return n;
    };
    const offset = (i: number): number => uint(table + i * offSize, offSize);
    let budget = 200_000;
    const read = (i: number, depth: number): Plist => {
      if (i >= count || depth > 64 || --budget < 0) throw new Error('bad plist');
      let at = offset(i);
      const marker = bytes[at]!;
      const kind = marker >> 4;
      let n = marker & 0xf;
      at++;
      const length = (): void => {
        if (n !== 0xf) return;
        const m = bytes[at]!;
        const size = 1 << (m & 0xf);
        n = uint(at + 1, size);
        at += 1 + size;
      };
      switch (kind) {
        case 0x0:
          return n === 0x8 ? false : n === 0x9 ? true : null;
        case 0x1: {
          const size = 1 << n;
          return size === 8 ? Number(view.getBigInt64(at)) : uint(at, size);
        }
        case 0x2:
          return n === 2 ? view.getFloat32(at) : view.getFloat64(at);
        case 0x3:
          return new Date(Date.UTC(2001, 0, 1) + view.getFloat64(at) * 1000);
        case 0x4:
          length();
          return bytes.slice(at, at + n);
        case 0x5:
          length();
          return String.fromCharCode(...bytes.subarray(at, at + n));
        case 0x6: {
          length();
          let s = '';
          for (let k = 0; k < n; k++) s += String.fromCharCode(view.getUint16(at + k * 2));
          return s;
        }
        case 0x8:
          return { UID: uint(at, n + 1) };
        case 0xa: {
          length();
          const out: Plist[] = [];
          for (let k = 0; k < n; k++) out.push(read(uint(at + k * refSize, refSize), depth + 1));
          return out;
        }
        case 0xd: {
          length();
          const out: Record<string, Plist> = {};
          for (let k = 0; k < n; k++) {
            const key = read(uint(at + k * refSize, refSize), depth + 1);
            out[String(key)] = read(uint(at + (n + k) * refSize, refSize), depth + 1);
          }
          return out;
        }
        default:
          return null;
      }
    };
    return read(top, 0);
  } catch {
    return undefined;
  }
}

// ---- XML plists

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const unescapeXml = (s: string): string => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e] ?? all)));

function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** An XML property list → its value, or undefined if it isn't one. */
export function parseXmlPlist(xml: string): Plist | undefined {
  try {
    const re = /<(\/?)([a-zA-Z]+)(?:\s+[^>]*?)?\s*(\/?)>|([^<]+)/g;
    const tokens: Array<{ close: boolean; tag: string; empty: boolean } | { text: string }> = [];
    for (const m of xml.replace(/<\?[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/g, '').matchAll(re)) {
      if (m[2]) tokens.push({ close: m[1] === '/', tag: m[2], empty: m[3] === '/' });
      else if (m[4]?.trim()) tokens.push({ text: m[4] });
    }
    let i = 0;
    const text = (tag: string): string => {
      let s = '';
      while (i < tokens.length) {
        const t = tokens[i++]!;
        if ('text' in t) s += t.text;
        else if (t.close && t.tag === tag) return unescapeXml(s);
      }
      throw new Error('unclosed');
    };
    const value = (depth: number): Plist => {
      if (depth > 64) throw new Error('deep');
      const t = tokens[i++];
      if (!t || 'text' in t || t.close) throw new Error('bad');
      if (t.tag === 'plist') {
        const v = value(depth + 1);
        return v;
      }
      if (t.empty) return t.tag === 'true' ? true : t.tag === 'false' ? false : t.tag === 'dict' ? {} : t.tag === 'array' ? [] : t.tag === 'string' ? '' : null;
      switch (t.tag) {
        case 'string':
          return text('string');
        case 'integer':
          return parseInt(text('integer'), 10);
        case 'real':
          return parseFloat(text('real'));
        case 'date':
          return new Date(text('date'));
        case 'data':
          return base64Bytes(text('data'));
        case 'true':
          text('true');
          return true;
        case 'false':
          text('false');
          return false;
        case 'array': {
          const out: Plist[] = [];
          for (;;) {
            const n = tokens[i];
            if (n && !('text' in n) && n.close && n.tag === 'array') {
              i++;
              return out;
            }
            out.push(value(depth + 1));
          }
        }
        case 'dict': {
          const out: Record<string, Plist> = {};
          for (;;) {
            const n = tokens[i];
            if (n && !('text' in n) && n.close && n.tag === 'dict') {
              i++;
              // XML keyed archives write UIDs as { CF$UID: n }.
              const keys = Object.keys(out);
              if (keys.length === 1 && keys[0] === 'CF$UID' && typeof out['CF$UID'] === 'number') return { UID: out['CF$UID'] };
              return out;
            }
            if (!n || 'text' in n || n.tag !== 'key') throw new Error('bad dict');
            i++;
            const key = n.empty ? '' : text('key');
            out[key] = value(depth + 1);
          }
        }
        default:
          throw new Error(`unknown ${t.tag}`);
      }
    };
    return value(0);
  } catch {
    return undefined;
  }
}

/** A property list's bytes (binary or XML) → its value. */
export function parsePlist(bytes: Uint8Array): Plist | undefined {
  if (bytes.length >= 8 && String.fromCharCode(...bytes.subarray(0, 6)) === 'bplist') return parseBplist(bytes);
  return parseXmlPlist(new TextDecoder().decode(bytes));
}

// ---- keyed archives (NSKeyedArchiver): Terminal's colours and fonts

/** A keyed archive's root object, its UIDs followed (cycles cut), with `$class` as its class name. */
export function unarchive(archive: Plist | Uint8Array | undefined): Plist | undefined {
  const root = archive instanceof Uint8Array ? parsePlist(archive) : archive;
  const a = asDict(root);
  const objects = a?.['$objects'];
  const top = asDict(a?.['$top'])?.['root'];
  if (!Array.isArray(objects) || !isUid(top)) return undefined;
  const list = objects as readonly Plist[];
  const resolve = (v: Plist, depth: number): Plist => {
    if (depth > 24) return null;
    if (isUid(v)) {
      const o = list[v.UID];
      return o === '$null' || o === undefined ? null : resolve(o, depth + 1);
    }
    if (Array.isArray(v)) return v.map((x) => resolve(x, depth + 1));
    const d = asDict(v);
    if (!d) return v;
    const out: Record<string, Plist> = {};
    for (const [k, x] of Object.entries(d)) {
      if (k === '$class') {
        const cls = asDict(isUid(x) ? list[x.UID] : x);
        out['$class'] = typeof cls?.['$classname'] === 'string' ? cls['$classname'] : null;
      } else out[k] = resolve(x, depth + 1);
    }
    return out;
  };
  return resolve(top, 0);
}

const bytesText = (v: unknown): string | undefined => (v instanceof Uint8Array ? String.fromCharCode(...v).replace(/\0+$/, '') : typeof v === 'string' ? v : undefined);

/** An archived NSColor (RGB or grey) → `#rrggbb`. Catalog and CMYK colours aren't read. */
export function archivedColor(data: unknown): string | undefined {
  const c = asDict(unarchive(data instanceof Uint8Array ? data : undefined));
  if (!c) return undefined;
  const nums = (v: unknown): number[] => (bytesText(v) ?? '').trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n));
  const rgb = nums(c['NSRGB']);
  if (rgb.length >= 3) return floatsToHex(rgb[0]!, rgb[1]!, rgb[2]!);
  const white = nums(c['NSWhite']);
  if (white.length >= 1) return floatsToHex(white[0]!, white[0]!, white[0]!);
  const comps = nums(c['NSComponents']);
  if (comps.length >= 3) return floatsToHex(comps[0]!, comps[1]!, comps[2]!);
  return undefined;
}

/** An archived NSFont → its PostScript name and size. */
export function archivedFont(data: unknown): { name: string; size: number } | undefined {
  const f = asDict(unarchive(data instanceof Uint8Array ? data : undefined));
  const name = f?.['NSName'];
  const size = f?.['NSSize'];
  return typeof name === 'string' && typeof size === 'number' ? { name, size } : undefined;
}

// ---- TOML (enough for Alacritty, WezTerm's colour schemes and Warp)

export type Loose = string | number | boolean | null | Loose[] | { [key: string]: Loose };
export type LooseTable = { [key: string]: Loose };

export const asTable = (v: unknown): LooseTable | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as LooseTable) : undefined);

/** A TOML document → its tables (arrays of tables keep their last one). Never throws: what it can't read it skips. */
export function parseToml(text: string): LooseTable {
  const root: LooseTable = {};
  let table = root;
  let i = 0;
  const src = text;
  const ws = (): void => {
    while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
  };
  const wsAll = (): void => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i]!)) i++;
      if (src[i] === '#') while (i < src.length && src[i] !== '\n') i++;
      else return;
    }
  };
  const toEol = (): void => {
    while (i < src.length && src[i] !== '\n') i++;
  };
  const str = (): string => {
    const q = src[i]!;
    const triple = src.startsWith(q.repeat(3), i);
    i += triple ? 3 : 1;
    let s = '';
    while (i < src.length) {
      if (triple ? src.startsWith(q.repeat(3), i) : src[i] === q) {
        i += triple ? 3 : 1;
        return triple ? s.replace(/^\n/, '') : s;
      }
      if (!triple && src[i] === '\n') return s;
      if (q === '"' && src[i] === '\\') {
        const e = src[i + 1];
        const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' };
        if (e === 'u' || e === 'U') {
          const len = e === 'u' ? 4 : 8;
          s += String.fromCodePoint(parseInt(src.slice(i + 2, i + 2 + len), 16) || 0xfffd);
          i += 2 + len;
        } else {
          s += map[e ?? ''] ?? e ?? '';
          i += 2;
        }
        continue;
      }
      s += src[i++];
    }
    return s;
  };
  const key = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      ws();
      if (src[i] === '"' || src[i] === "'") parts.push(str());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i, i + 200));
        if (!m) break;
        parts.push(m[0]);
        i += m[0].length;
      }
      ws();
      if (src[i] === '.') i++;
      else break;
    }
    return parts;
  };
  const value = (depth: number): Loose => {
    if (depth > 32) throw new Error('deep');
    wsAll();
    const c = src[i];
    if (c === '"' || c === "'") return str();
    if (c === '[') {
      i++;
      const out: Loose[] = [];
      for (;;) {
        wsAll();
        if (src[i] === ']') {
          i++;
          return out;
        }
        if (i >= src.length) return out;
        out.push(value(depth + 1));
        wsAll();
        if (src[i] === ',') i++;
      }
    }
    if (c === '{') {
      i++;
      const out: LooseTable = {};
      for (;;) {
        wsAll();
        if (src[i] === '}') {
          i++;
          return out;
        }
        if (i >= src.length) return out;
        const k = key();
        ws();
        if (src[i] !== '=' || !k.length) throw new Error('bad inline table');
        i++;
        setPath(out, k, value(depth + 1));
        wsAll();
        if (src[i] === ',') i++;
      }
    }
    const m = /^[^\s,\]}#]+/.exec(src.slice(i, i + 200));
    if (!m) throw new Error('bad value');
    i += m[0].length;
    const raw = m[0];
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    const n = Number(raw.replace(/_/g, ''));
    return Number.isFinite(n) ? n : raw;
  };
  while (i < src.length) {
    wsAll();
    if (i >= src.length) break;
    try {
      if (src[i] === '[') {
        const arr = src[i + 1] === '[';
        i += arr ? 2 : 1;
        const k = key();
        toEol();
        let t: LooseTable = root;
        k.forEach((part, n) => {
          const last = n === k.length - 1;
          if (last && arr) {
            const list = Array.isArray(t[part]) ? (t[part] as Loose[]) : [];
            const fresh: LooseTable = {};
            list.push(fresh);
            t[part] = list;
            t = fresh;
            return;
          }
          const existing = t[part];
          const next = Array.isArray(existing) ? asTable(existing.at(-1)) : asTable(existing);
          if (next) t = next;
          else {
            const fresh: LooseTable = {};
            t[part] = fresh;
            t = fresh;
          }
        });
        table = t;
        continue;
      }
      const k = key();
      ws();
      if (src[i] !== '=' || !k.length) {
        toEol();
        continue;
      }
      i++;
      setPath(table, k, value(0));
      toEol();
    } catch {
      toEol();
    }
  }
  return root;
}

function setPath(t: LooseTable, keys: readonly string[], v: Loose): void {
  let at = t;
  keys.slice(0, -1).forEach((k) => {
    const next = asTable(at[k]);
    if (next) at = next;
    else {
      const fresh: LooseTable = {};
      at[k] = fresh;
      at = fresh;
    }
  });
  at[keys.at(-1)!] = v;
}

// ---- YAML (enough for Alacritty's old alacritty.yml and Warp's themes)

const yamlScalar = (raw: string): Loose => {
  const v = raw.trim();
  if (/^".*"$/.test(v)) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  if (v === '' || v === '~' || v === 'null') return null;
  if (/^(true|yes|on)$/i.test(v)) return true;
  if (/^(false|no|off)$/i.test(v)) return false;
  if (/^[-+]?(\d[\d_]*\.?\d*([eE][-+]?\d+)?|\.\d+)$/.test(v)) return Number(v.replace(/_/g, ''));
  if (/^\[.*\]$/.test(v))
    return v
      .slice(1, -1)
      .split(',')
      .map((x) => yamlScalar(x))
      .filter((x) => x !== null);
  return v;
};

/** Strip a trailing comment, keeping `#` inside quotes and colours like `'#1e1e2e'`. */
const yamlUncomment = (line: string): string => {
  let q: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = undefined;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
};

/** A block-style YAML document of maps, lists and scalars (no anchors, no flow maps) → its value. */
export function parseYaml(text: string): LooseTable {
  const lines = text
    .split(/\r?\n/)
    .map((l) => yamlUncomment(l.replace(/\t/g, '  ')).replace(/\s+$/, ''))
    .filter((l) => l.trim() && l.trim() !== '---');
  let i = 0;
  const indentOf = (l: string): number => l.length - l.trimStart().length;
  const block = (indent: number, depth: number): Loose => {
    if (depth > 32 || i >= lines.length) return null;
    const first = lines[i]!;
    if (first.trimStart().startsWith('- ') || first.trim() === '-') {
      const out: Loose[] = [];
      while (i < lines.length && indentOf(lines[i]!) === indent && lines[i]!.trimStart().startsWith('-')) {
        const rest = lines[i]!.trimStart().slice(1).trim();
        if (!rest) {
          i++;
          out.push(i < lines.length && indentOf(lines[i]!) > indent ? block(indentOf(lines[i]!), depth + 1) : null);
        } else if (/^[^'"]*?:(\s|$)/.test(rest) && !/^["']/.test(rest)) {
          // "- key: value" opens a map at the item's indent.
          lines[i] = `${' '.repeat(indent + 2)}${rest}`;
          out.push(block(indent + 2, depth + 1));
        } else {
          i++;
          out.push(yamlScalar(rest));
        }
      }
      return out;
    }
    const out: LooseTable = {};
    while (i < lines.length && indentOf(lines[i]!) === indent) {
      const line = lines[i]!.trim();
      const m = /^("[^"]*"|'[^']*'|[^:]+?)\s*:(?:\s+(.*))?$/.exec(line);
      i++;
      if (!m) continue;
      const k = m[1]!.replace(/^["']|["']$/g, '');
      const rest = m[2]?.trim();
      if (rest && rest !== '|' && rest !== '>') out[k] = yamlScalar(rest);
      else if (i < lines.length && (indentOf(lines[i]!) > indent || (indentOf(lines[i]!) === indent && lines[i]!.trimStart().startsWith('- ')))) out[k] = block(indentOf(lines[i]!), depth + 1);
      else out[k] = null;
    }
    // Lines deeper than this map but not under a key: skip them.
    while (i < lines.length && indentOf(lines[i]!) > indent) i++;
    return out;
  };
  try {
    const out: LooseTable = {};
    while (i < lines.length) {
      const v = block(indentOf(lines[i]!), 0);
      const t = asTable(v);
      if (t) Object.assign(out, t);
      else i++;
    }
    return out;
  } catch {
    return {};
  }
}
