import { expect, test, type Locator, type Page } from './fixtures.js';

/**
 * The file reader: a file from the panel's Files opened full size takes the center (the panel
 * steps aside and comes back with Esc), scrolls, and reads Markdown the way GitHub does (outline,
 * alerts, code, math, diagrams, images, links between pages). The demo's bob-api has docs/GUIDE.md.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Panel' });
const aside = (page: Page) => page.locator('aside[aria-label="Panel"]');
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const center = (page: Page) => page.getByRole('main');
/** The page a file scrolls in, across the center. */
const reading = (page: Page) => center(page).locator('[data-reader-scroll]');

async function openWorkspace(page: Page, name = 'add-auth'): Promise<void> {
  await expect(sidebar(page).getByRole('button', { name: 'bob-api' }).first()).toBeVisible();
  const row = sidebar(page).getByRole('button', { name, exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name, exact: true }).click();
  await expect(composer(page)).toHaveAttribute('placeholder', new RegExp(name));
}

/** Show a file in the panel's Files (opening its folder in the tree first), previewed under it. */
async function preview(page: Page, folder: string, file: string): Promise<Locator> {
  await panel(page).getByRole('tab', { name: 'Files', exact: true }).click();
  const dir = panel(page).getByRole('treeitem', { name: folder, exact: true });
  await expect(dir).toBeVisible();
  if ((await dir.getAttribute('aria-expanded')) !== 'true') await dir.click();
  await panel(page).getByRole('treeitem', { name: file, exact: true }).click();
  const region = panel(page).getByRole('region', { name: file });
  await expect(region).toBeVisible();
  return region;
}

async function openGuide(page: Page): Promise<void> {
  await openWorkspace(page);
  const region = await preview(page, 'docs', 'GUIDE.md');
  await expect(region.getByRole('heading', { name: 'bob-api guide' })).toBeVisible();
  await region.getByRole('button', { name: 'Open in full' }).click();
  await expect(center(page).getByRole('region', { name: 'GUIDE.md' })).toBeVisible();
}

const scrollOf = (target: Locator) => target.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, view: el.clientHeight }));

/** How far below the top of the page an element sits. */
const offsetIn = (page: Page, target: Locator) =>
  target.evaluate((el) => el.getBoundingClientRect().top - (el.closest('[data-reader-scroll]')?.getBoundingClientRect().top ?? 0));

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('the panel’s preview of a long Markdown file scrolls', async ({ page }) => {
  await openWorkspace(page);
  const region = await preview(page, 'docs', 'GUIDE.md');
  const body = region.locator('[data-reader-scroll]');
  await expect(region.getByRole('heading', { name: 'Getting started' })).toBeAttached();
  const before = await scrollOf(body);
  expect(before.height).toBeGreaterThan(before.view);
  await body.hover();
  await page.mouse.wheel(0, 900);
  await expect.poll(async () => (await scrollOf(body)).top).toBeGreaterThan(200);
});

test('full size: no second copy in the panel, the panel steps aside and comes back with Esc', async ({ page }) => {
  await openGuide(page);
  // The panel slid away: no smaller copy of the same file on the right.
  await expect(aside(page)).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByRole('region', { name: 'GUIDE.md' })).toHaveCount(1);
  // A clean header: where it is, how it's shown, and what you can do with it.
  const file = center(page).getByRole('region', { name: 'GUIDE.md' });
  await expect(file.getByRole('navigation', { name: 'Path' })).toHaveText(/add-auth.*docs.*GUIDE\.md/);
  for (const name of ['Copy the text', 'Open in Editor', 'Show in Finder']) await expect(file.getByRole('button', { name })).toBeVisible();
  await expect(file.getByRole('tab', { name: 'Rendered' })).toHaveAttribute('aria-selected', 'true');
  // Esc: back to the chat, and the panel is back with the file under its tree.
  await page.keyboard.press('Escape');
  await expect(composer(page)).toBeVisible();
  await expect(aside(page)).toHaveAttribute('aria-hidden', 'false');
  await expect(panel(page).getByRole('region', { name: 'GUIDE.md' })).toBeVisible();
});

test('showing the panel yourself while a file is full size: the tree, without the file again', async ({ page }) => {
  await openGuide(page);
  await page.keyboard.press('Meta+Alt+0');
  await expect(aside(page)).toHaveAttribute('aria-hidden', 'false');
  await expect(panel(page).getByRole('treeitem', { name: 'GUIDE.md' })).toBeVisible();
  await expect(panel(page).getByRole('region', { name: 'GUIDE.md' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to Chat' }).click();
  // Your choice stays: the panel is still there, now with the preview.
  await expect(panel(page).getByRole('region', { name: 'GUIDE.md' })).toBeVisible();
});

test('the page scrolls with the wheel and the keyboard', async ({ page }) => {
  await openGuide(page);
  const pageEl = reading(page);
  const start = await scrollOf(pageEl);
  expect(start.height).toBeGreaterThan(start.view * 2);
  expect(start.top).toBe(0);
  await pageEl.hover();
  await page.mouse.wheel(0, 700);
  await expect.poll(async () => (await scrollOf(pageEl)).top).toBeGreaterThan(300);
  // It has the keyboard when it opens: Page Down, Space, End and Home.
  await pageEl.evaluate((el) => el.scrollTo({ top: 0 }));
  await pageEl.focus();
  await page.keyboard.press('PageDown');
  await expect.poll(async () => (await scrollOf(pageEl)).top).toBeGreaterThan(start.view / 2);
  // Page Down scrolls smoothly: Space goes on from where it stops.
  let last = -1;
  await expect
    .poll(async () => {
      const top = (await scrollOf(pageEl)).top;
      const still = top === last;
      last = top;
      return still;
    }, { intervals: [100] })
    .toBe(true);
  const afterPage = last;
  await page.keyboard.press('Space');
  await expect.poll(async () => (await scrollOf(pageEl)).top).toBeGreaterThan(afterPage + 100);
  await page.keyboard.press('End');
  await expect.poll(async () => { const s = await scrollOf(pageEl); return s.height - s.view - s.top; }).toBeLessThan(4);
  await page.keyboard.press('Home');
  await expect.poll(async () => (await scrollOf(pageEl)).top).toBe(0);
});

test('the outline jumps to a section and follows along; Rendered and Source', async ({ page }) => {
  await openGuide(page);
  const outline = center(page).getByRole('navigation', { name: 'Outline' });
  await expect(outline.getByRole('link')).toContainText(['bob-api guide', 'Getting started', "What's where"]);
  await outline.getByRole('link', { name: 'Retries and backoff' }).click();
  const heading = center(page).getByRole('heading', { name: 'Retries and backoff' });
  await expect.poll(async () => Math.abs(await offsetIn(page, heading))).toBeLessThan(40);
  await expect(outline.getByRole('link', { name: 'Retries and backoff' })).toHaveAttribute('aria-current', 'location');
  // Scrolling on: the outline follows.
  await reading(page).evaluate((el) => {
    const h = [...el.querySelectorAll('h2')].find((x) => x.textContent?.includes('Troubleshooting'))!;
    el.scrollTop += h.getBoundingClientRect().top - el.getBoundingClientRect().top - 10;
  });
  await expect(outline.getByRole('link', { name: 'Troubleshooting' })).toHaveAttribute('aria-current', 'location');
  // Source: the Markdown as written, with line numbers; and back.
  const file = center(page).getByRole('region', { name: 'GUIDE.md' });
  await file.getByRole('tab', { name: 'Source' }).click();
  await expect(file.getByText('## Getting started')).toBeAttached();
  await expect(file.locator('[data-n="1"]')).toBeAttached();
  await expect(outline).toHaveCount(0);
  await file.getByRole('tab', { name: 'Rendered' }).click();
  await expect(file.getByRole('heading', { name: 'Getting started' })).toBeAttached();
});

test('GitHub’s Markdown: alerts, tables, task lists, footnotes, front matter, and safe HTML', async ({ page }) => {
  await openGuide(page);
  const doc = center(page).locator('[data-markdown-doc]');
  for (const kind of ['note', 'tip', 'important', 'warning', 'caution']) await expect(doc.locator(`.markdown-alert-${kind} .markdown-alert-title`)).toHaveCount(1);
  await expect(doc.locator('.markdown-alert-warning')).toContainText('Migrations run before the new code');
  await expect(doc.locator('table').first().locator('th')).toHaveText(['Path', 'What it does', 'Owner', 'Tests']);
  await expect(doc.locator('input[type="checkbox"]:checked')).toHaveCount(3);
  await expect(doc.locator('input[type="checkbox"]:not(:checked)')).toHaveCount(3);
  await expect(doc.locator('del')).toHaveText('SOAP endpoint');
  await expect(doc.getByRole('term').first()).toHaveText('title');
  await expect(doc.locator('section.footnotes li')).toContainText('before jitter');
  await expect(doc.locator('details summary').first()).toHaveText('Webhooks return 400 locally');
  await expect(doc.locator('kbd')).toHaveCount(3);
  // Clicking a footnote goes to it.
  await reading(page).evaluate((el) => el.scrollTo({ top: 0 }));
  await doc.locator('sup a').first().click();
  await expect(doc.locator('section.footnotes li').first()).toBeInViewport();
});

test('a relative .md link opens in the reader at its section; other files open in Files', async ({ page }) => {
  await openGuide(page);
  await center(page).getByRole('link', { name: 'API reference' }).first().click();
  const api = center(page).getByRole('region', { name: 'API.md' });
  await expect(api.getByRole('heading', { name: 'API reference' })).toBeVisible();
  await expect.poll(async () => Math.abs(await offsetIn(page, api.getByRole('heading', { name: 'Authentication' })))).toBeLessThan(40);
  // Back to the guide's Idempotency section.
  await api.getByRole('link', { name: 'guide' }).click();
  const guide = center(page).getByRole('region', { name: 'GUIDE.md' });
  await expect.poll(async () => Math.abs(await offsetIn(page, guide.getByRole('heading', { name: 'Idempotency' })))).toBeLessThan(40);
  // Code goes to the panel's Files, next to the chat.
  await guide.getByRole('link', { name: 'src/server.ts' }).click();
  await expect(composer(page)).toBeVisible();
  await expect(panel(page).getByRole('region', { name: 'server.ts' }).getByText('requireUser').first()).toBeVisible();
});

test('mermaid draws its diagrams, KaTeX typesets math, and images next to the file show', async ({ page }) => {
  await openGuide(page);
  const doc = center(page).locator('[data-markdown-doc]');
  const diagrams = doc.getByRole('img', { name: 'Diagram' });
  await expect(diagrams).toHaveCount(2);
  await expect(diagrams.first().locator('svg')).toBeAttached({ timeout: 20_000 });
  await expect(diagrams.nth(1).locator('svg')).toBeAttached({ timeout: 20_000 });
  await expect(diagrams.first()).toContainText('charge.succeeded');
  // No script from a diagram ran, and nothing it left behind is in the page.
  await expect(page.locator('body > [id^="dklaud-mermaid"], body > [id^="klaud-mermaid"]')).toHaveCount(0);
  await expect(doc.locator('.katex').first()).toBeAttached({ timeout: 15_000 });
  await expect(doc.locator('.katex-display')).toHaveCount(1);
  expect(await doc.locator('.katex').count()).toBeGreaterThan(5);
  const image = doc.getByRole('img', { name: 'The webhook flow' });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(100);
});

test('a long code file full size: line numbers, scrolling, wrap, and ⌘F', async ({ page }) => {
  await openWorkspace(page);
  const region = await preview(page, 'src', 'payments.ts');
  await region.getByRole('button', { name: 'Open in full' }).click();
  const file = center(page).getByRole('region', { name: 'payments.ts' });
  await expect(file.locator('[data-n="120"]')).toBeAttached();
  const pageEl = reading(page);
  const s = await scrollOf(pageEl);
  expect(s.height).toBeGreaterThan(s.view);
  await pageEl.hover();
  await page.mouse.wheel(0, 800);
  await expect.poll(async () => (await scrollOf(pageEl)).top).toBeGreaterThan(300);
  await file.getByRole('button', { name: 'Wrap long lines' }).click();
  await expect(file.getByRole('button', { name: 'Don’t wrap long lines' })).toHaveAttribute('aria-pressed', 'true');
  await file.getByRole('button', { name: 'Don’t wrap long lines' }).click();
  // Find: every match counted, Return goes to the next.
  await page.keyboard.press('Meta+F');
  const find = page.getByRole('search', { name: 'Find in this file' });
  await expect(find.getByRole('textbox')).toBeFocused();
  await find.getByRole('textbox').fill('PaymentError');
  await expect(find).toContainText(/1 of \d+/);
  await find.getByRole('textbox').press('Enter');
  await expect(find).toContainText(/2 of \d+/);
  await find.getByRole('textbox').press('Escape');
  await expect(find).toHaveCount(0);
  // Esc again: back to the chat.
  await page.keyboard.press('Escape');
  await expect(composer(page)).toBeVisible();
});

test('a diff full size: the panel steps aside, with no second copy of it', async ({ page }) => {
  await openWorkspace(page);
  await panel(page).getByRole('tab', { name: 'Changes', exact: true }).click();
  await panel(page).getByRole('option', { name: /server\.ts/ }).click();
  const diff = panel(page).getByRole('region', { name: 'Changes in server.ts' });
  await diff.getByRole('button', { name: 'Open in full' }).click();
  await expect(page.getByRole('button', { name: 'Back to Chat' })).toBeVisible();
  await expect(aside(page)).toHaveAttribute('aria-hidden', 'true');
  await page.keyboard.press('Meta+Alt+0');
  await expect(panel(page).getByRole('listbox', { name: 'Changed files' })).toBeVisible();
  await expect(panel(page).getByRole('region', { name: 'Changes in server.ts' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(panel(page).getByRole('region', { name: 'Changes in server.ts' })).toBeVisible();
});
