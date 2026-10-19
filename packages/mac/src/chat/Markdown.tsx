import { memo, useEffect, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ATTACHMENT_SCHEME } from '@klaud/core/attachment-share.js';
import type { LinkTarget } from '@klaud/shared/link-target.js';
import { parseAttachmentHref } from '@klaud/shared/attachment-links.js';
import { Icon } from '../components/Icon.js';
import { openLightbox } from './images.js';
import { useActions } from '../lib/actions.js';
import { ActionsContext, type ActionItem } from '../components/SpecMenu.js';
import { copyText } from '../lib/copy.js';
import { useKlaud } from '../lib/klaud.js';
import { MentionPill } from './Mention.js';
import { type MentionWorld, linkMentions, parseMentionHref } from './mentions.js';
import { quoteInBox } from './message-menu.js';
import s from './chat.module.css';

/** Syntax colors load on demand (shiki is big), then stay. */
let highlighter: Promise<{ codeToHtml: (code: string, opts: { lang: string; themes: { light: string; dark: string } }) => string; langs: Set<string> }> | undefined;

function loadHighlighter() {
  highlighter ??= import('shiki').then(async ({ createHighlighter }) => {
    const langs = ['ts', 'tsx', 'js', 'jsx', 'json', 'bash', 'sh', 'python', 'go', 'rust', 'css', 'html', 'md', 'yaml', 'sql', 'diff', 'swift', 'java', 'kotlin', 'c', 'cpp', 'ruby', 'toml'];
    const h = await createHighlighter({ themes: ['github-light', 'github-dark-dimmed'], langs });
    return { codeToHtml: (code, opts) => h.codeToHtml(code, opts), langs: new Set(h.getLoadedLanguages() as string[]) };
  });
  return highlighter;
}

function Code({ code, lang }: { code: string; lang?: string }) {
  const [html, setHtml] = useState<string | undefined>();
  useEffect(() => {
    if (!lang) return;
    let alive = true;
    void loadHighlighter().then((h) => {
      if (!alive || !h.langs.has(lang)) return;
      setHtml(h.codeToHtml(code, { lang, themes: { light: 'github-light', dark: 'github-dark-dimmed' } }));
    });
    return () => {
      alive = false;
    };
  }, [code, lang]);
  const { client, ui } = useKlaud();
  const say = (text: string): void => client.store.dispatch({ type: 'toast', text, level: 'success' });
  const copy = (text: string, what: string): void => void copyText(text).then(() => say(`Copied ${what}`));
  const fence = `\`\`\`${lang ?? ''}\n${code}\n\`\`\``;
  const items: ActionItem[] = [
    { label: 'Copy Code', icon: 'copy', onSelect: () => copy(code, 'the code') },
    { label: 'Copy as Markdown', onSelect: () => copy(fence, 'as Markdown') },
    { label: 'Quote in Reply', icon: 'chat', separate: true, onSelect: () => quoteInBox(ui, fence) },
  ];
  return (
    <ActionsContext items={items}>
      <div className={s.codeBlock}>
        <button type="button" className={s.copyCode} onClick={() => copy(code, 'the code')} aria-label="Copy code">
          Copy
        </button>
        {/* eslint-disable-next-line react/no-danger */}
        {html ? <div className={s.shiki} dangerouslySetInnerHTML={{ __html: html }} /> : <pre><code>{code}</code></pre>}
      </div>
    </ActionsContext>
  );
}

/** Where a markdown link goes: a web page, an image someone sent, or a file in a share. */
function targetOf(href: string): LinkTarget {
  if (/^https?:\/\//i.test(href)) return { kind: 'url', url: href };
  if (href.startsWith(ATTACHMENT_SCHEME)) {
    const rest = href.slice(ATTACHMENT_SCHEME.length);
    const at = rest.indexOf('/');
    return { kind: 'attachment', owner: rest.slice(0, at), file: rest.slice(at + 1), label: 'image' };
  }
  if (href.startsWith('/') || href.startsWith('~')) return { kind: 'local', path: href, dir: href.endsWith('/') };
  return { kind: 'href', href };
}

/** Paths in plain text ("src/app.ts:12", "~/notes/") become links (local ones, when you wrote them). */
const PATH = /(^|[\s(`'"])((?:~|\.{1,2})?\/[\w@.+-][\w@.+/-]*|[\w@+-][\w@.+-]*\/[\w@.+/-]*\.[A-Za-z][\w-]{0,9})(?::(\d+))?/g;

function linkifyPaths(text: string): string {
  let fenced = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) fenced = !fenced;
      // Leave code, existing links and inline code alone.
      if (fenced || line.includes('](') || line.includes('`')) return line;
      return line.replace(PATH, (_m, lead: string, p: string, n?: string) => `${lead}[${p}${n ? `:${n}` : ''}](klaud-path:${encodeURIComponent(p)}${n ? `#${n}` : ''})`);
    })
    .join('\n');
}

/** `mentions`: draw "@mia", "@bob-api", "@src/auth.ts"… as pills when they name someone or something here. */
export const Markdown = memo(function Markdown({ text, paths = false, mentions }: { text: string; paths?: boolean; mentions?: MentionWorld }) {
  const actions = useActions();
  const components: Components = {
    a: ({ href = '', children }) => {
      const mention = parseMentionHref(href);
      if (mention) return <MentionPill mention={mention} />;
      // An image mentioned mid-sentence: a small link that opens it full size.
      const image = parseAttachmentHref(href);
      if (image) {
        const label = /image \d+/.exec(String(children))?.[0] ?? 'image';
        return (
          <a href={href} className={s.imageRef} onClick={(e) => (e.preventDefault(), openLightbox([{ href, ...image, label }]))}>
            <Icon name="image" size={11} />
            {label}
          </a>
        );
      }
      return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault();
          if (href.startsWith('klaud-path:')) {
            const [raw, line] = href.slice('klaud-path:'.length).split('#');
            const p = decodeURIComponent(raw ?? '');
            actions.openLink({ kind: 'local', path: p, dir: p.endsWith('/'), ...(line ? { line: Number(line) } : {}) });
            return;
          }
          actions.openLink(targetOf(href));
        }}
      >
        {children}
      </a>
      );
    },
    code: ({ className, children }) => {
      const lang = /language-(\w+)/.exec(className ?? '')?.[1];
      const code = String(children).replace(/\n$/, '');
      if (!className && !code.includes('\n')) return <code className={s.inlineCode}>{children}</code>;
      return <Code code={code} {...(lang ? { lang } : {})} />;
    },
    pre: ({ children }) => <>{children}</>,
    table: ({ children }) => (
      <div className={s.tableWrap}>
        <table>{children}</table>
      </div>
    ),
  };
  return (
    <div className={`${s.markdown} selectable`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={(u) => u}>
        {((t: string) => (paths ? linkifyPaths(t) : t))(mentions ? linkMentions(text, mentions) : text)}
      </ReactMarkdown>
    </div>
  );
});
