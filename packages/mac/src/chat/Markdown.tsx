import { memo, useEffect, useMemo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ATTACHMENT_SCHEME } from '@klaud/core/attachment-share.js';
import type { LinkTarget } from '@klaud/shared/link-target.js';
import { parseAttachmentHref } from '@klaud/shared/attachment-links.js';
import { Icon } from '../components/Icon.js';
import { type ChatImage, openLightbox } from './images.js';
import { Thumb } from './ChatImages.js';
import { imageSource, localImage, messageImages } from './md-images.js';
import { useActions } from '../lib/actions.js';
import { ActionsContext, type ActionItem } from '../components/SpecMenu.js';
import { copyText } from '../lib/copy.js';
import { useKlaud } from '../lib/klaud.js';
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

/** An image in the text: a file on this Mac as a thumbnail (click for full size), else a quiet chip. */
function MdImage({ src, alt, all }: { src: string; alt: string; all: readonly ChatImage[] }) {
  const actions = useActions();
  const source = imageSource(src);
  if (source.kind === 'local') {
    const index = all.findIndex((i) => i.local === source.path);
    const image = all[index] ?? localImage(source.path, alt);
    return <Thumb image={image} all={index < 0 ? [image] : all} index={Math.max(0, index)} tiled={false} />;
  }
  // The window only loads what klaud reads for it, so a web image opens in the browser instead.
  if (source.kind === 'remote') {
    return (
      <a href={source.url} className={s.imageRef} title={source.url} onClick={(e) => (e.preventDefault(), actions.openLink({ kind: 'url', url: source.url }))}>
        <Icon name="image" size={11} />
        {alt || new URL(source.url).hostname}
      </a>
    );
  }
  return (
    <span className={s.imageRef} title={`Can’t show ${src}`}>
      <Icon name="image" size={11} />
      {alt || 'image'}
    </span>
  );
}

type HastNode = { type: string; tagName?: string; value?: string; children?: HastNode[] };

/** How many images a paragraph holds when it's nothing but images (0 otherwise). */
function imagesOnly(node: HastNode | undefined): number {
  const kids = node?.children ?? [];
  const images = kids.filter((k) => k.type === 'element' && k.tagName === 'img').length;
  const rest = kids.filter((k) => !(k.type === 'element' && k.tagName === 'img') && !(k.type === 'text' && !k.value?.trim()) && !(k.type === 'element' && k.tagName === 'br'));
  return rest.length ? 0 : images;
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

export const Markdown = memo(function Markdown({ text, paths = false }: { text: string; paths?: boolean }) {
  const actions = useActions();
  // Every local image in the message, so the lightbox steps from one to the next.
  const images = useMemo(() => messageImages(text), [text]);
  const components: Components = {
    img: ({ src, alt }) => <MdImage src={typeof src === 'string' ? src : ''} alt={alt ?? ''} all={images} />,
    // A paragraph of nothing but images: a row of them (several get smaller, side by side).
    p: ({ node, children }) => {
      const count = imagesOnly(node as HastNode | undefined);
      return count ? (
        <div className={s.mdImages} data-count={count > 1 ? 'many' : 'one'}>
          {children}
        </div>
      ) : (
        <p>{children}</p>
      );
    },
    a: ({ href = '', children }) => {
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
        {paths ? linkifyPaths(text) : text}
      </ReactMarkdown>
    </div>
  );
});
