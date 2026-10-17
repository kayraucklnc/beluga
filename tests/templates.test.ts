import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILT_IN_TEMPLATES, addTemplate, cursorFor, loadTemplates, removeTemplate, templatesFile } from '../src/core/templates.js';

let home: string;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.KLAUDE_HOME;
  home = mkdtempSync(path.join(os.tmpdir(), 'klaude-templates-'));
  process.env.KLAUDE_HOME = home;
});

afterEach(() => {
  if (previous === undefined) delete process.env.KLAUDE_HOME;
  else process.env.KLAUDE_HOME = previous;
});

const custom = (file = templatesFile()): unknown => JSON.parse(readFileSync(file, 'utf8'));

describe('templates', () => {
  it('lives under KLAUDE_HOME', () => {
    expect(templatesFile()).toBe(path.join(home, 'templates.json'));
  });

  it('lists the built-ins when nothing is saved', () => {
    const list = loadTemplates();
    expect(list).toEqual([...BUILT_IN_TEMPLATES]);
    expect(list.map((t) => t.id)).toEqual(['fix-ci', 'add-tests', 'bug', 'feature', 'refactor', 'deps', 'explain', 'review-pr']);
    expect(list.every((t) => t.builtIn)).toBe(true);
    expect(list.find((t) => t.id === 'feature')?.plan).toBe(true);
  });

  it('adds a template after the built-ins and saves only custom ones', () => {
    const list = addTemplate('  Release  ', '  Cut a release.  ');
    const added = list[list.length - 1]!;
    expect(list).toHaveLength(BUILT_IN_TEMPLATES.length + 1);
    expect(added).toMatchObject({ name: 'Release', prompt: 'Cut a release.' });
    expect(added.id).toMatch(/^[0-9a-f]{8}$/);
    expect(added).not.toHaveProperty('plan');
    expect(custom()).toEqual([{ id: added.id, name: 'Release', prompt: 'Cut a release.' }]);
    expect(readFileSync(templatesFile(), 'utf8').endsWith('\n')).toBe(true);
    expect(loadTemplates()).toEqual(list);
  });

  it('keeps the plan flag', () => {
    const list = addTemplate('Design', 'Plan it', true);
    expect(list[list.length - 1]).toMatchObject({ plan: true });
    expect(custom()).toEqual([expect.objectContaining({ name: 'Design', plan: true })]);
    expect(loadTemplates().at(-1)).toMatchObject({ plan: true });
  });

  it('replaces a template with the same name, case-insensitively', () => {
    addTemplate('Release', 'old');
    addTemplate('Other', 'x');
    const list = addTemplate('RELEASE', 'new');
    const customs = list.filter((t) => !t.builtIn);
    expect(customs.map((t) => [t.name, t.prompt])).toEqual([
      ['Other', 'x'],
      ['RELEASE', 'new'],
    ]);
  });

  it('never replaces a built-in with the same name', () => {
    const list = addTemplate('add tests', 'mine');
    expect(list.filter((t) => t.name.toLowerCase() === 'add tests')).toHaveLength(2);
    expect(list.find((t) => t.id === 'add-tests')).toBeDefined();
  });

  it('truncates long names and prompts', () => {
    const list = addTemplate('n'.repeat(100), 'p'.repeat(9000));
    const added = list.at(-1)!;
    expect(added.name).toHaveLength(60);
    expect(added.prompt).toHaveLength(8000);
    expect(loadTemplates().at(-1)).toEqual(added);
  });

  it('removes a custom template by id', () => {
    const a = addTemplate('A', 'a').at(-1)!;
    addTemplate('B', 'b');
    const list = removeTemplate(a.id);
    expect(list.filter((t) => !t.builtIn).map((t) => t.name)).toEqual(['B']);
    expect(loadTemplates()).toEqual(list);
  });

  it("can't remove a built-in", () => {
    const list = removeTemplate('fix-ci');
    expect(list).toEqual([...BUILT_IN_TEMPLATES]);
    expect(custom()).toEqual([]);
  });

  it('ignores an unknown id', () => {
    addTemplate('A', 'a');
    expect(removeTemplate('nope').filter((t) => !t.builtIn)).toHaveLength(1);
  });

  it('falls back to the built-ins when the file is broken', () => {
    const file = templatesFile();
    writeFileSync(file, '{not json');
    expect(loadTemplates()).toEqual([...BUILT_IN_TEMPLATES]);
    writeFileSync(file, JSON.stringify([{ id: 'x', name: '', prompt: 'p' }]));
    expect(loadTemplates()).toEqual([...BUILT_IN_TEMPLATES]);
    writeFileSync(file, JSON.stringify({ not: 'an array' }));
    expect(loadTemplates()).toEqual([...BUILT_IN_TEMPLATES]);
  });

  it('overwrites a broken file on the next add', () => {
    writeFileSync(templatesFile(), 'garbage');
    const list = addTemplate('A', 'a');
    expect(list.filter((t) => !t.builtIn)).toHaveLength(1);
    expect(custom()).toEqual([expect.objectContaining({ name: 'A' })]);
  });

  it('accepts an explicit file path and creates its directory', () => {
    const file = path.join(home, 'nested', 'dir', 't.json');
    addTemplate('A', 'a', false, file);
    expect(existsSync(file)).toBe(true);
    expect(loadTemplates(file).at(-1)).toMatchObject({ name: 'A' });
    expect(existsSync(templatesFile())).toBe(false);
    expect(removeTemplate('fix-ci', file).at(-1)).toMatchObject({ name: 'A' });
  });

  it('leaves no temp file behind', () => {
    mkdirSync(home, { recursive: true });
    addTemplate('A', 'a');
    expect(existsSync(`${templatesFile()}.${process.pid}.tmp`)).toBe(false);
  });
});

describe('cursorFor', () => {
  it('puts the cursor in a double-space blank', () => {
    expect(cursorFor('Refactor  to be simpler')).toBe('Refactor '.length);
  });

  it('puts the cursor after a "#" placeholder', () => {
    expect(cursorFor('Review pull request # (use gh)')).toBe('Review pull request #'.length);
  });

  it('puts the cursor before the "." in ": ."', () => {
    expect(cursorFor('There is a bug: . Reproduce it')).toBe('There is a bug: '.length);
  });

  it('prefers a double space over the other blanks', () => {
    expect(cursorFor('a: . b # c  d')).toBe('a: . b # c '.length);
    expect(cursorFor('a: . b # c')).toBe('a: . b #'.length);
  });

  it('goes to the end otherwise', () => {
    expect(cursorFor('Add tests for ')).toBe('Add tests for '.length);
    expect(cursorFor('')).toBe(0);
  });

  it('lands on a sensible spot for every built-in', () => {
    for (const t of BUILT_IN_TEMPLATES) {
      const at = cursorFor(t.prompt);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThanOrEqual(t.prompt.length);
    }
  });
});
