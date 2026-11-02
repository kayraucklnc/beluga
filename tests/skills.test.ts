import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { frontmatter, listSkills } from '../src/core/claude-code/skills.js';
import { suggest } from '../src/ui/suggest.js';

const write = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

/** Claude's skills and custom commands for the / list (BLG-217). */
describe('listSkills', () => {
  it("reads the project's, yours and your enabled plugins' skills and commands", async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'skills-'));
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'repo');
    write(path.join(cwd, '.claude/skills/deploy/SKILL.md'), '---\nname: deploy\ndescription: "Ship it to staging"\n---\nBody');
    write(path.join(home, 'skills/deploy/SKILL.md'), '---\nname: deploy\ndescription: mine\n---\n');
    write(path.join(home, 'commands/fix.md'), '---\nargument-hint: [issue]\n---\n# Fix an issue\nSteps');
    write(path.join(home, 'commands/git/sync.md'), 'Sync with origin');
    const plugin = path.join(root, 'plugin');
    write(path.join(plugin, 'skills/migrate/SKILL.md'), '---\nname: migrate\ndescription: Run migrations\n---\n');
    write(path.join(root, 'off/skills/nope/SKILL.md'), '---\nname: nope\n---\n');
    write(path.join(home, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'supabase@mkt': [{ installPath: plugin }], 'off@mkt': [{ installPath: path.join(root, 'off') }] } }));
    write(path.join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'supabase@mkt': true, 'off@mkt': false } }));
    const skills = await listSkills(cwd, home);
    expect(skills).toEqual([
      { name: 'deploy', description: 'Ship it to staging', kind: 'skill', source: 'project' },
      { name: 'fix', description: 'Fix an issue', kind: 'command', source: 'user', args: '[issue]' },
      { name: 'sync', description: 'Sync with origin', kind: 'command', source: 'user' },
      { name: 'supabase:migrate', description: 'Run migrations', kind: 'skill', source: 'plugin' },
    ]);
  });

  it('copes with nothing there', async () => {
    expect(await listSkills(undefined, path.join(tmpdir(), 'no-such-claude-home'))).toEqual([]);
    expect(frontmatter('no frontmatter\nmore')).toEqual({ fields: {}, firstLine: 'no frontmatter' });
  });
});

describe('suggest: skills under /', () => {
  const skills = [
    { name: 'supabase:migrate', description: 'Run migrations', kind: 'skill' as const, source: 'plugin' as const },
    { name: 'review', description: 'Claude reviews', kind: 'command' as const, source: 'user' as const },
  ];
  it("lists them after Beluga's commands, each with its kind", () => {
    const out = suggest('/', { peers: [], selfId: 'me', skills });
    expect(out.at(-1)).toMatchObject({ label: '/review', kind: 'skill', value: '//review ' });
    expect(out.find((s) => s.label === '/supabase:migrate')).toMatchObject({ value: '/supabase:migrate ', hint: 'Run migrations' });
    expect(out[0]).toMatchObject({ kind: 'command' });
  });
  it('matches a part of the name', () => {
    expect(suggest('/mig', { peers: [], selfId: 'me', skills }).map((s) => s.label)).toEqual(['/supabase:migrate']);
  });
});
