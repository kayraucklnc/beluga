import type { FileEntryView, FilePageView, FolderView, FoundView, MacFrame, TerminalView } from '../protocol';

/**
 * The demo Mac's worktrees (BLG-42): a small file tree per project to browse and read, and a
 * shell that answers like one (a prompt, a few commands, colours), shared the way the real one is:
 * what you type echoes back as the Mac's PTY would echo it.
 */

type Tree = Readonly<Record<string, string>>;

const WEATHER: Tree = {
  'README.md': '# pixel-weather\n\nA tiny forecast app with a home-screen widget.\n\n## Develop\n\n```sh\nnpm install\nnpm run dev\n```\n\nSigning in from the widget goes through `src/auth/redirect.ts`.\n',
  'package.json': '{\n  "name": "pixel-weather",\n  "version": "2.4.0",\n  "private": true,\n  "scripts": {\n    "dev": "vite",\n    "test": "vitest run",\n    "build": "vite build"\n  },\n  "dependencies": {\n    "react": "^19.3.0",\n    "zod": "^4.6.7"\n  }\n}\n',
  'tsconfig.json': '{\n  "compilerOptions": {\n    "strict": true,\n    "target": "ES2022",\n    "module": "ESNext",\n    "jsx": "react-jsx"\n  },\n  "include": ["src"]\n}\n',
  'src/auth/redirect.ts': [
    "import { z } from 'zod';",
    "import { session } from './session';",
    '',
    '/** Where to go after signing in: the deep link the widget opened, if it is one of ours. */',
    'const ReturnTo = z.string().startsWith(\'/\').max(512);',
    '',
    'export function afterSignIn(url: URL): string {',
    "  const wanted = url.searchParams.get('returnTo');",
    '  // The widget sends its deep link encoded twice; decode once more before checking it.',
    '  const decoded = wanted ? decodeURIComponent(wanted) : undefined;',
    '  const parsed = ReturnTo.safeParse(decoded);',
    "  if (!parsed.success) return '/forecast';",
    '  session.remember({ landedAt: Date.now() });',
    '  return parsed.data;',
    '}',
    '',
  ].join('\n'),
  'src/auth/session.ts': "/** The signed-in user, kept for the tab's life. */\nexport const session = {\n  user: undefined as string | undefined,\n  remember(extra: Record<string, unknown>): void {\n    Object.assign(this, extra);\n  },\n};\n",
  'src/widget/open.ts': "import { afterSignIn } from '../auth/redirect';\n\nexport function openFromWidget(link: string): string {\n  const url = new URL(`https://pixel.weather/login?returnTo=${encodeURIComponent(encodeURIComponent(link))}`);\n  return afterSignIn(url);\n}\n",
  'src/ui/Radar.tsx': "import { useEffect, useState } from 'react';\n\nexport function Radar({ city }: { city: string }) {\n  const [frames, setFrames] = useState<string[]>([]);\n  useEffect(() => {\n    void fetch(`/api/radar/${city}`).then((r) => r.json()).then(setFrames);\n  }, [city]);\n  return <div className=\"radar\">{frames.length} frames</div>;\n}\n",
  'src/ui/radar.css': '.radar {\n  display: grid;\n  border-radius: 12px;\n  background: #cfe3fa;\n}\n',
  'tests/redirect.test.ts': "import { describe, expect, it } from 'vitest';\nimport { openFromWidget } from '../src/widget/open';\n\ndescribe('signing in from the widget', () => {\n  it('lands on the deep link', () => {\n    expect(openFromWidget('/forecast/oslo')).toBe('/forecast/oslo');\n  });\n});\n",
  'scripts/deploy.sh': '#!/bin/sh\nset -e\nnpm run build\n# Ship the static build.\nrsync -a dist/ deploy@pixel.weather:/srv/www/\n',
  '.gitignore': 'node_modules\ndist\n.env\n',
};

const BELUGA: Tree = {
  'README.md': '# Beluga\n\nThe engine and its two screens: the Mac app and the phone companion.\n',
  'package.json': '{\n  "name": "beluga",\n  "version": "0.15.0",\n  "type": "module",\n  "scripts": {\n    "test": "vitest run",\n    "typecheck": "tsc --noEmit"\n  }\n}\n',
  'src/companion/host.ts': "/** Your Mac's side of the phone link. */\nexport class CompanionHost {\n  private readonly links = new Set<PhoneLink>();\n\n  async start(): Promise<void> {\n    // Only paired phones get through the firewall.\n    await this.sync();\n  }\n}\n",
  'src/companion/protocol.ts': "import { z } from 'zod';\n\nexport const COMPANION_PROTO = { major: 1, minor: 7 } as const;\nexport const KEEPALIVE_MS = 20_000;\n",
  'packages/companion/app/index.tsx': "export default function Home() {\n  return null;\n}\n",
  'docs/companion.md': '# Beluga for phones\n\nA phone app for one person: you.\n',
};

const treeOf = (project: string | undefined): Tree => (project === 'pixel-weather' ? WEATHER : BELUGA);

/** A folder of the demo worktree, as companion.files.list answers. */
export function demoFolder(project: string | undefined, rel: string): FolderView {
  const tree = treeOf(project);
  const prefix = rel ? `${rel.replace(/\/+$/, '')}/` : '';
  const dirs = new Set<string>();
  const files: FileEntryView[] = [];
  for (const [p, text] of Object.entries(tree)) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash >= 0) dirs.add(rest.slice(0, slash));
    else files.push({ name: rest, dir: false, size: new TextEncoder().encode(text).length });
  }
  if (!dirs.size && !files.length && rel) throw new Error('That isn’t there any more');
  const by = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  return { path: rel, entries: [...[...dirs].map((name) => ({ name, dir: true })).sort(by), ...files.sort(by)] };
}

export function demoFind(project: string | undefined, query: string): FoundView {
  const q = query.toLowerCase();
  const hits: FoundView['hits'] = [];
  const seen = new Set<string>();
  for (const p of Object.keys(treeOf(project))) {
    const parts = p.split('/');
    parts.forEach((name, i) => {
      const path = parts.slice(0, i + 1).join('/');
      if (name.toLowerCase().includes(q) && !seen.has(path)) {
        seen.add(path);
        hits.push({ path, dir: i < parts.length - 1 });
      }
    });
  }
  return { hits };
}

const LANG: Record<string, string> = { ts: 'ts', tsx: 'ts', js: 'js', json: 'json', md: 'md', css: 'css', sh: 'sh' };

export function demoRead(project: string | undefined, rel: string): FilePageView {
  if (/(^|\/)\.env/.test(rel)) throw new Error('That file is secret: it never leaves your Mac');
  const text = treeOf(project)[rel];
  if (text === undefined) throw new Error('That isn’t there any more');
  const size = new TextEncoder().encode(text).length;
  const lang = LANG[rel.split('.').pop() ?? ''];
  return { path: rel, text, off: 0, next: size, size, eof: true, ...(lang ? { lang } : {}) };
}

// ---- the shell

const ESC = '\x1b';
const dim = (s: string) => `${ESC}[2m${s}${ESC}[0m`;
const green = (s: string) => `${ESC}[32m${s}${ESC}[0m`;
const red = (s: string) => `${ESC}[31m${s}${ESC}[0m`;
const cyan = (s: string) => `${ESC}[36m${s}${ESC}[0m`;
const bold = (s: string) => `${ESC}[1m${s}${ESC}[0m`;

/** One demo terminal: a prompt that answers a few commands, with the Mac's size. */
export class DemoShell {
  readonly cols = 80;
  readonly rows = 24;
  running = true;
  private line = '';
  private backlog = '';

  constructor(
    readonly key: string,
    readonly label: string,
    private readonly project: string | undefined,
    private readonly branch: string,
  ) {
    this.backlog = `${dim('Last login: Fri Oct 24 09:12 on ttys004')}\r\n${this.prompt()}npm test\r\n\r\n${this.tests()}${this.prompt()}`;
  }

  view(): TerminalView {
    return { key: this.key, label: this.label, running: this.running, cols: this.cols, rows: this.rows };
  }

  private prompt(): string {
    return `${cyan(this.project ?? 'beluga')} ${dim(`(${this.branch})`)} ${bold('$')} `;
  }

  private tests(): string {
    return [` ${bold('RUN')}  v5.0.5 ~/${this.project ?? 'beluga'}`, '', ` ${green('✓')} tests/redirect.test.ts ${dim('(3 tests) 12ms')}`, ` ${green('✓')} tests/radar.test.ts ${dim('(5 tests) 31ms')}`, '', ` ${bold('Test Files')}  ${green('2 passed')} (2)`, `      ${bold('Tests')}  ${green('8 passed')} (8)`, ''].join('\r\n') + '\r\n';
  }

  /** What it wrote so far (what a screen attaching now draws). */
  screen(): string {
    return this.backlog;
  }

  /** Keys in → what the PTY writes back (echo, and a command's output on Enter). */
  input(data: string): string {
    let out = '';
    // Arrows and other keys with escape sequences: a real shell moves through history; the demo stays put.
    for (const ch of data.replace(/\x1b(\[[0-9;?]*[A-Za-z~]|O[A-Za-z]|.)?/g, '')) {
      if (ch === '\r' || ch === '\n') {
        out += '\r\n' + this.run(this.line.trim()) + this.prompt();
        this.line = '';
      } else if (ch === '\x7f' || ch === '\b') {
        if (this.line) {
          this.line = this.line.slice(0, -1);
          out += '\b \b';
        }
      } else if (ch === '\x03') {
        out += '^C\r\n' + this.prompt();
        this.line = '';
      } else if (ch === '\x0c') {
        out += `${ESC}[H${ESC}[2J` + this.prompt() + this.line;
      } else if (ch === '\t') {
        const words = ['src/', 'tests/', 'package.json', 'README.md'];
        const last = this.line.split(' ').pop() ?? '';
        const hit = words.find((w) => last && w.startsWith(last));
        if (hit) {
          out += hit.slice(last.length);
          this.line += hit.slice(last.length);
        } else out += '\x07';
      } else if (ch < ' ') {
        // Other control keys do nothing here.
      } else if (/[\x20-\x7e -￿]/.test(ch)) {
        this.line += ch;
        out += ch;
      }
    }
    this.backlog = (this.backlog + out).slice(-60_000);
    return out;
  }

  private run(cmd: string): string {
    if (!cmd) return '';
    const [name, ...args] = cmd.split(/\s+/);
    switch (name) {
      case 'ls':
        return `${cyan('src')}  ${cyan('tests')}  ${cyan('scripts')}  package.json  README.md  tsconfig.json\r\n`;
      case 'pwd':
        return `/Users/you/.beluga/workspaces/${this.project ?? 'beluga'}/${this.branch.replace(/^beluga\//, '')}\r\n`;
      case 'echo':
        return `${args.join(' ')}\r\n`;
      case 'whoami':
        return 'you\r\n';
      case 'date':
        return `${new Date().toString()}\r\n`;
      case 'clear':
        return `${ESC}[H${ESC}[2J`;
      case 'git':
        return args[0] === 'status' ? `On branch ${this.branch}\r\nChanges not staged for commit:\r\n\t${red('modified:   src/auth/redirect.ts')}\r\n\r\n` : `${dim('(the demo Mac only knows git status)')}\r\n`;
      case 'npm':
        return args[0] === 'test' || args[0] === 't' ? `\r\n${this.tests()}` : `${dim(`(the demo Mac only runs npm test)`)}\r\n`;
      default:
        return `zsh: command not found: ${name}\r\n`;
    }
  }
}

/** The frames a demo shell's screen starts with (its status, then what's on it from a clean screen). */
export function demoAttach(shell: DemoShell): MacFrame[] {
  return [
    { t: 'term_status', term: shell.key, running: shell.running, cols: shell.cols, rows: shell.rows },
    { t: 'term_data', term: shell.key, data: shell.screen(), reset: true },
  ];
}
