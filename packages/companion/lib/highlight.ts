/**
 * Cheap syntax colours for the phone's read-only source viewer (BLG-42): one pass per line with a
 * few regular expressions (keywords, strings, comments, numbers, types), and block comments carried
 * from line to line. Not a parser: good enough to read code on a phone, and fast on a 500 KB file.
 */

export type TokenKind = 'plain' | 'keyword' | 'string' | 'comment' | 'number' | 'type' | 'heading';
export interface Token {
  readonly text: string;
  readonly kind: TokenKind;
}

interface Lang {
  readonly keywords: ReadonlySet<string>;
  /** Line comment markers. */
  readonly line: readonly string[];
  /** Block comments [open, close]. */
  readonly block?: readonly [string, string];
  /** Capitalised words read as types (TypeScript, Go, Rust…). */
  readonly types?: boolean;
  readonly backtick?: boolean;
}

const words = (s: string): ReadonlySet<string> => new Set(s.split(/\s+/).filter(Boolean));
const C_LIKE = 'if else for while do switch case default break continue return try catch finally throw new delete typeof instanceof in of void this super class extends implements interface enum public private protected static readonly abstract const let var function async await yield import export from as true false null undefined';
const LANGS: Record<string, Lang> = {
  ts: { keywords: words(`${C_LIKE} type keyof infer namespace declare satisfies is unknown never any string number boolean bigint symbol object`), line: ['//'], block: ['/*', '*/'], types: true, backtick: true },
  js: { keywords: words(C_LIKE), line: ['//'], block: ['/*', '*/'], types: true, backtick: true },
  json: { keywords: words('true false null'), line: [] },
  py: { keywords: words('def class if elif else for while in not and or is return import from as with try except finally raise pass break continue lambda yield global nonlocal assert del async await True False None self'), line: ['#'], types: true },
  rb: { keywords: words('def class module if elsif else unless case when while until for in do end return yield begin rescue ensure raise self nil true false and or not then require'), line: ['#'], types: true },
  go: { keywords: words('func package import var const type struct interface map chan go defer select if else for range switch case default break continue return fallthrough goto nil true false'), line: ['//'], block: ['/*', '*/'], types: true, backtick: true },
  rs: { keywords: words('fn let mut const static struct enum trait impl for in if else match loop while break continue return use mod pub crate self Self super where as ref move async await dyn unsafe true false Some None Ok Err'), line: ['//'], block: ['/*', '*/'], types: true },
  swift: { keywords: words('func let var class struct enum protocol extension if else guard for in while repeat switch case default break continue return throw throws try catch import public private internal fileprivate static self Self nil true false async await some any'), line: ['//'], block: ['/*', '*/'], types: true },
  kt: { keywords: words('fun val var class object interface data sealed enum if else when for in while do return throw try catch finally import package public private internal protected override open abstract this super null true false suspend'), line: ['//'], block: ['/*', '*/'], types: true },
  java: { keywords: words(`${C_LIKE} package int long double float boolean char byte short final synchronized throws`), line: ['//'], block: ['/*', '*/'], types: true },
  c: { keywords: words('if else for while do switch case default break continue return goto sizeof struct union enum typedef static const extern volatile inline void int char short long float double signed unsigned bool true false NULL #include #define #ifdef #ifndef #endif #if #else'), line: ['//'], block: ['/*', '*/'], types: true },
  cpp: { keywords: words('if else for while do switch case default break continue return class struct namespace template typename using public private protected virtual override const static auto void int char bool float double long unsigned new delete nullptr true false #include #define'), line: ['//'], block: ['/*', '*/'], types: true },
  cs: { keywords: words(`${C_LIKE} namespace using int string bool double float decimal var void sealed override virtual get set`), line: ['//'], block: ['/*', '*/'], types: true },
  sh: { keywords: words('if then else elif fi for while until do done case esac in function return export local readonly set unset echo exit source'), line: ['#'] },
  css: { keywords: words('@media @import @keyframes @font-face !important'), line: [], block: ['/*', '*/'] },
  html: { keywords: words(''), line: [], block: ['<!--', '-->'] },
  yaml: { keywords: words('true false null yes no on off'), line: ['#'] },
  toml: { keywords: words('true false'), line: ['#'] },
  sql: { keywords: words('select from where and or not insert into values update set delete create table index view drop alter join left right inner outer on group by order having limit offset as distinct union all null is in like between case when then else end primary key references'), line: ['--'], block: ['/*', '*/'] },
  lua: { keywords: words('local function end if then else elseif for in do while repeat until return break nil true false and or not'), line: ['--'] },
  php: { keywords: words(`${C_LIKE} echo namespace use fn`), line: ['//', '#'], block: ['/*', '*/'] },
  docker: { keywords: words('FROM RUN CMD COPY ADD WORKDIR ENV ARG EXPOSE ENTRYPOINT USER VOLUME LABEL'), line: ['#'] },
  make: { keywords: words('ifeq ifneq else endif include define endef export'), line: ['#'] },
};

const NUMBER = /^(0x[\da-f_]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?)\b/i;
const WORD = /^[A-Za-z_$#@!][\w$-]*/;

/** Where each line starts: inside a block comment or not (one pass over the file). */
export function blockStates(lines: readonly string[], lang: string | undefined): boolean[] {
  const l = lang ? LANGS[lang] : undefined;
  const out: boolean[] = new Array(lines.length);
  if (!l?.block) return out.fill(false);
  const [open, close] = l.block;
  let inside = false;
  for (let i = 0; i < lines.length; i++) {
    out[i] = inside;
    const s = lines[i]!;
    // Good enough: comment markers inside strings are rare in the code worth reading on a phone.
    let at = 0;
    for (;;) {
      if (inside) {
        const end = s.indexOf(close, at);
        if (end < 0) break;
        inside = false;
        at = end + close.length;
      } else {
        const lineAt = l.line.map((m) => s.indexOf(m, at)).filter((x) => x >= 0);
        const startAt = s.indexOf(open, at);
        if (startAt < 0 || lineAt.some((x) => x < startAt)) break;
        inside = true;
        at = startAt + open.length;
      }
    }
  }
  return out;
}

/** One line in coloured pieces. `inBlock`: it starts inside a block comment (blockStates). */
export function tokenize(line: string, lang: string | undefined, inBlock = false): Token[] {
  if (lang === 'md') return markdownLine(line);
  const l = lang ? LANGS[lang] : undefined;
  if (!l || line.length > 2000) return [{ text: line, kind: 'plain' }];
  const out: Token[] = [];
  let plain = '';
  const push = (text: string, kind: TokenKind): void => {
    if (kind === 'plain') return void (plain += text);
    if (plain) out.push({ text: plain, kind: 'plain' });
    plain = '';
    if (text) out.push({ text, kind });
  };
  let i = 0;
  if (inBlock && l.block) {
    const end = line.indexOf(l.block[1]);
    if (end < 0) return [{ text: line, kind: 'comment' }];
    push(line.slice(0, end + l.block[1].length), 'comment');
    i = end + l.block[1].length;
  }
  while (i < line.length) {
    const rest = line.slice(i);
    const ch = line[i]!;
    const lineMark = l.line.find((m) => rest.startsWith(m));
    if (lineMark) {
      push(rest, 'comment');
      break;
    }
    if (l.block && rest.startsWith(l.block[0])) {
      const end = line.indexOf(l.block[1], i + l.block[0].length);
      const stop = end < 0 ? line.length : end + l.block[1].length;
      push(line.slice(i, stop), 'comment');
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || (ch === '`' && l.backtick)) {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
      const str = line.slice(i, Math.min(line.length, j + 1));
      // A JSON key reads as a name, its value as a string.
      push(str, lang === 'json' && /^\s*:/.test(line.slice(j + 1)) ? 'type' : 'string');
      i = Math.min(line.length, j + 1);
      continue;
    }
    if (/\d/.test(ch) && !/[\w$]/.test(line[i - 1] ?? '')) {
      const m = NUMBER.exec(rest);
      if (m) {
        push(m[0], 'number');
        i += m[0].length;
        continue;
      }
    }
    const w = WORD.exec(rest);
    if (w && !/[\w$]/.test(line[i - 1] ?? '')) {
      const word = w[0];
      if (l.keywords.has(word)) push(word, 'keyword');
      else if (l.types && /^[A-Z][a-z0-9]/.test(word)) push(word, 'type');
      else push(word, 'plain');
      i += word.length;
      continue;
    }
    push(ch, 'plain');
    i++;
  }
  push('', 'plain');
  if (plain) out.push({ text: plain, kind: 'plain' });
  return out;
}

function markdownLine(line: string): Token[] {
  if (/^\s{0,3}#{1,6}\s/.test(line)) return [{ text: line, kind: 'heading' }];
  if (/^\s*```/.test(line)) return [{ text: line, kind: 'comment' }];
  const out: Token[] = [];
  let at = 0;
  for (const m of line.matchAll(/`[^`]+`/g)) {
    if (m.index! > at) out.push({ text: line.slice(at, m.index), kind: 'plain' });
    out.push({ text: m[0], kind: 'string' });
    at = m.index! + m[0].length;
  }
  if (at < line.length) out.push({ text: line.slice(at), kind: 'plain' });
  return out.length ? out : [{ text: line, kind: 'plain' }];
}

/** The language's name in words, for the viewer's header. */
export const LANG_NAMES: Readonly<Record<string, string>> = {
  ts: 'TypeScript', js: 'JavaScript', json: 'JSON', py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', swift: 'Swift', kt: 'Kotlin', java: 'Java', c: 'C', cpp: 'C++', cs: 'C#',
  sh: 'Shell', css: 'CSS', html: 'HTML', md: 'Markdown', yaml: 'YAML', toml: 'TOML', sql: 'SQL', lua: 'Lua', php: 'PHP', docker: 'Dockerfile', make: 'Makefile',
};
