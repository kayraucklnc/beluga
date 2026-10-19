import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A believable two weeks of history for the demo's landing project (several people, feature
 * branches merged back, a tag, a branch still open), and a teammate who pushed after your last
 * pull: the project home shows "3 behind origin/main", and History has a graph worth looking at.
 */

interface Person {
  readonly name: string;
  readonly email: string;
}

const KAY: Person = { name: 'Kay', email: 'kay@klaud.dev' };
const MIA: Person = { name: 'Mia Chen', email: 'mia@studio.dev' };
const BOB: Person = { name: 'Bob Rivera', email: 'bob@rivera.io' };
const SAM: Person = { name: 'Sam Okafor', email: 'sam@okafor.dev' };

const HOUR = 3_600_000;

function run(cwd: string, who: Person, hoursAgo: number, args: readonly string[]): void {
  const when = new Date(Date.now() - hoursAgo * HOUR).toISOString();
  execFileSync('git', ['-c', `user.name=${who.name}`, '-c', `user.email=${who.email}`, ...args], {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
  });
}

function commit(cwd: string, who: Person, hoursAgo: number, message: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    writeFileSync(path.join(cwd, rel), content);
  }
  run(cwd, who, hoursAgo, ['add', '.']);
  run(cwd, who, hoursAgo, ['commit', '-q', '-m', message]);
}

const branch = (cwd: string, name: string, from = 'main'): void => void execFileSync('git', ['switch', '-q', '-c', name, from], { cwd, stdio: 'ignore' });
const checkout = (cwd: string, name: string): void => void execFileSync('git', ['switch', '-q', name], { cwd, stdio: 'ignore' });
const merge = (cwd: string, who: Person, hoursAgo: number, name: string): void => run(cwd, who, hoursAgo, ['merge', '-q', '--no-ff', name, '-m', `Merge branch '${name}'`]);

/** Fill `dir` (a fresh clone of `origin` on main) with history, push it, then let a teammate push more. */
export function seedLandingHistory(dir: string, origin: string, scratch: string): void {
  const d = 24;
  commit(dir, KAY, 13 * d, 'Set up the landing page skeleton', { 'src/pages/index.astro': '<Layout>\n  <Hero />\n</Layout>\n', 'package.json': '{ "name": "landing", "scripts": { "dev": "astro dev" } }\n' });
  branch(dir, 'feat/pricing');
  commit(dir, MIA, 12 * d + 5, 'Add the pricing table', { 'src/components/Pricing.astro': '<table class="pricing">\n  <tr><td>Solo</td><td>$0</td></tr>\n</table>\n' });
  commit(dir, MIA, 11 * d + 20, 'Pricing: monthly and annual toggle', { 'src/components/Pricing.astro': '<Toggle />\n<table class="pricing">\n  <tr><td>Solo</td><td>$0</td></tr>\n  <tr><td>Team</td><td>$12</td></tr>\n</table>\n' });
  checkout(dir, 'main');
  commit(dir, BOB, 11 * d + 3, 'Fix the footer links', { 'src/components/Footer.astro': '<footer><a href="/docs">Docs</a> · <a href="/blog">Blog</a></footer>\n' });
  merge(dir, KAY, 10 * d, 'feat/pricing');
  branch(dir, 'feat/blog');
  commit(dir, SAM, 9 * d + 6, 'Blog index page', { 'src/pages/blog/index.astro': '<h1>Blog</h1>\n<PostList />\n' });
  checkout(dir, 'main');
  commit(dir, KAY, 8 * d + 9, 'Hero copy: “Build together”', { 'content/hero.md': '# Build together\n\nYou, your friends, and everyone’s Claude.\n' });
  checkout(dir, 'feat/blog');
  commit(dir, SAM, 8 * d + 2, 'RSS feed for the blog', { 'src/pages/rss.xml.ts': 'export const GET = () => rss({ title: "klaud blog" });\n' });
  checkout(dir, 'main');
  merge(dir, MIA, 7 * d, 'feat/blog');
  run(dir, KAY, 7 * d, ['tag', 'v0.1']);
  branch(dir, 'fix/mobile-nav');
  commit(dir, BOB, 5 * d + 4, 'Mobile nav no longer covers the hero', { 'src/components/Nav.astro': '<nav class="nav nav--sticky">…</nav>\n' });
  checkout(dir, 'main');
  commit(dir, KAY, 4 * d + 7, 'Tighten the hero spacing', { 'src/styles/hero.css': '.hero { padding: 96px 0 72px; }\n' });
  merge(dir, KAY, 4 * d, 'fix/mobile-nav');
  commit(dir, MIA, 3 * d, 'Add launch announcement banner', { 'src/components/Banner.astro': '<div class="banner">We’re live! 🎉</div>\n' });
  execFileSync('git', ['branch', '-q', '-D', 'feat/pricing', 'fix/mobile-nav'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['push', '-q', 'origin', 'main', 'feat/blog', '--tags'], { cwd: dir, stdio: 'ignore' });

  // A teammate keeps going after your last pull: origin/main moves on, and a branch is still open.
  const mate = path.join(scratch, 'landing-teammate');
  execFileSync('git', ['clone', '-q', origin, mate], { stdio: 'ignore' });
  commit(mate, MIA, 2 * d + 3, 'Testimonials section', { 'src/components/Testimonials.astro': '<blockquote>“We shipped in a weekend.”</blockquote>\n' });
  commit(mate, SAM, d + 5, 'Compress the hero images', { 'public/hero.webp.txt': 'webp, 84 KB (was 410 KB)\n' });
  branch(mate, 'feat/dark-mode');
  commit(mate, MIA, 20, 'Dark mode: tokens', { 'src/styles/tokens.css': ':root[data-theme="dark"] { --bg: #111; }\n' });
  commit(mate, MIA, 9, 'Dark mode: toggle in the nav', { 'src/components/ThemeToggle.astro': '<button aria-label="Theme">◐</button>\n' });
  checkout(mate, 'main');
  commit(mate, BOB, 6, 'Update the pricing copy', { 'src/components/Pricing.astro': '<Toggle />\n<table class="pricing">\n  <tr><td>Solo</td><td>Free</td></tr>\n  <tr><td>Team</td><td>$12 / seat</td></tr>\n</table>\n' });
  execFileSync('git', ['push', '-q', 'origin', 'main', 'feat/dark-mode'], { cwd: mate, stdio: 'ignore' });
  // Your copy knows about it (as after a fetch), so it shows as 3 behind.
  execFileSync('git', ['fetch', '-q', 'origin'], { cwd: dir, stdio: 'ignore' });
}
