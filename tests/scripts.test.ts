import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { detectRun, detectSetup, readProjectFile, resolveScripts, saveProjectFile, scriptEnv } from '../src/workspaces/scripts.js';

let dir: string;
const touch = (name: string, content = '') => writeFileSync(path.join(dir, name), content);
const pkg = (scripts: Record<string, unknown>) => touch('package.json', JSON.stringify({ name: 'x', scripts }));

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-scripts-'));
});

describe('detectSetup', () => {
  it.each([
    ['pnpm-lock.yaml', 'pnpm install'],
    ['yarn.lock', 'yarn install'],
    ['bun.lockb', 'bun install'],
    ['bun.lock', 'bun install'],
    ['package-lock.json', 'npm install'],
    ['uv.lock', 'uv sync'],
    ['poetry.lock', 'poetry install'],
    ['Gemfile.lock', 'bundle install'],
    ['composer.lock', 'composer install'],
  ])('%s → %s', (file, command) => {
    touch(file);
    expect(detectSetup(dir)).toBe(command);
  });

  it('prefers pnpm over package-lock when both exist', () => {
    touch('package-lock.json');
    touch('pnpm-lock.yaml');
    expect(detectSetup(dir)).toBe('pnpm install');
  });

  it('falls back to npm install for a bare package.json', () => {
    pkg({});
    expect(detectSetup(dir)).toBe('npm install');
  });

  it('creates a venv for requirements.txt', () => {
    touch('requirements.txt');
    expect(detectSetup(dir)).toBe('python3 -m venv .venv && .venv/bin/pip install -r requirements.txt');
  });

  it('returns undefined for an empty folder', () => {
    expect(detectSetup(dir)).toBeUndefined();
  });
});

describe('detectRun', () => {
  it('uses npm run dev by default', () => {
    pkg({ dev: 'vite', start: 'node .' });
    expect(detectRun(dir)).toBe('npm run dev');
  });

  it('falls back to start when there is no dev', () => {
    pkg({ start: 'node .' });
    expect(detectRun(dir)).toBe('npm run start');
  });

  it.each([
    ['pnpm-lock.yaml', 'pnpm dev'],
    ['yarn.lock', 'yarn dev'],
    ['bun.lockb', 'bun dev'],
    ['bun.lock', 'bun dev'],
  ])('with %s runs %s', (lock, command) => {
    touch(lock);
    pkg({ dev: 'vite' });
    expect(detectRun(dir)).toBe(command);
  });

  it('uses the runner for start too', () => {
    touch('yarn.lock');
    pkg({ start: 'node .' });
    expect(detectRun(dir)).toBe('yarn start');
  });

  it('ignores non-string scripts', () => {
    pkg({ dev: 42 });
    expect(detectRun(dir)).toBeUndefined();
  });

  it('ignores invalid package.json', () => {
    touch('package.json', '{not json');
    touch('Cargo.toml');
    expect(detectRun(dir)).toBe('cargo run');
  });

  it('detects cargo and go', () => {
    touch('Cargo.toml');
    expect(detectRun(dir)).toBe('cargo run');
    const other = mkdtempSync(path.join(os.tmpdir(), 'klaud-scripts-go-'));
    writeFileSync(path.join(other, 'go.mod'), 'module x\n');
    expect(detectRun(other)).toBe('go run .');
  });

  it('prefers package.json scripts over Cargo.toml', () => {
    pkg({ dev: 'vite' });
    touch('Cargo.toml');
    expect(detectRun(dir)).toBe('npm run dev');
  });

  it('returns undefined when nothing matches', () => {
    pkg({ build: 'tsc' });
    expect(detectRun(dir)).toBeUndefined();
  });
});

describe('readProjectFile', () => {
  it('returns nothing for missing or invalid files', () => {
    expect(readProjectFile(dir)).toEqual({ file: undefined, conductor: undefined });
    touch('klaud.json', '{oops');
    touch('conductor.json', JSON.stringify({ scripts: { setup: '' } }));
    expect(readProjectFile(dir)).toEqual({ file: undefined, conductor: undefined });
  });

  it('defaults scripts to {} and trims commands', () => {
    touch('klaud.json', JSON.stringify({ prPrompt: 'hi' }));
    touch('conductor.json', JSON.stringify({ scripts: { run: '  make  ' } }));
    expect(readProjectFile(dir)).toEqual({ file: { scripts: {}, prPrompt: 'hi' }, conductor: { run: 'make' } });
  });
});

describe('resolveScripts', () => {
  it('prefers yours > klaud.json > conductor.json > detected', () => {
    touch('package-lock.json');
    pkg({ dev: 'vite' });
    expect(resolveScripts(dir)).toEqual({ setup: { command: 'npm install', source: 'detected' }, run: { command: 'npm run dev', source: 'detected' } });

    touch('conductor.json', JSON.stringify({ scripts: { setup: 'c-setup', run: 'c-run' } }));
    expect(resolveScripts(dir)).toEqual({ setup: { command: 'c-setup', source: 'conductor.json' }, run: { command: 'c-run', source: 'conductor.json' } });

    touch('klaud.json', JSON.stringify({ scripts: { setup: 'k-setup' } }));
    expect(resolveScripts(dir)).toEqual({ setup: { command: 'k-setup', source: 'klaud.json' }, run: { command: 'c-run', source: 'conductor.json' } });

    expect(resolveScripts(dir, { run: 'mine' })).toEqual({ setup: { command: 'k-setup', source: 'klaud.json' }, run: { command: 'mine', source: 'yours' } });
  });

  it('treats an empty string of yours as unset', () => {
    touch('klaud.json', JSON.stringify({ scripts: { setup: 'k-setup' } }));
    expect(resolveScripts(dir, { setup: '' }).setup).toEqual({ command: 'k-setup', source: 'klaud.json' });
  });

  it('omits keys when nothing is found', () => {
    expect(resolveScripts(dir)).toEqual({});
  });

  it('includes prPrompt from klaud.json', () => {
    touch('klaud.json', JSON.stringify({ prPrompt: 'Link the ticket.' }));
    expect(resolveScripts(dir)).toEqual({ prPrompt: 'Link the ticket.' });
  });

  it('ignores an empty prPrompt', () => {
    touch('klaud.json', JSON.stringify({ prPrompt: '' }));
    expect(resolveScripts(dir)).not.toHaveProperty('prPrompt');
  });
});

describe('saveProjectFile', () => {
  const read = () => JSON.parse(readFileSync(path.join(dir, 'klaud.json'), 'utf8')) as Record<string, unknown>;

  it('creates klaud.json with a trailing newline', () => {
    saveProjectFile(dir, { setup: 'npm ci' });
    const text = readFileSync(path.join(dir, 'klaud.json'), 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(read()).toEqual({ scripts: { setup: 'npm ci' } });
  });

  it('keeps other fields and existing scripts', () => {
    touch('klaud.json', JSON.stringify({ prPrompt: 'p', other: 1, scripts: { setup: 'old', run: 'keep' } }));
    saveProjectFile(dir, { setup: 'new' });
    expect(read()).toEqual({ prPrompt: 'p', other: 1, scripts: { setup: 'new', run: 'keep' } });
  });

  it('overwrites an unreadable file', () => {
    touch('klaud.json', '{nope');
    saveProjectFile(dir, { run: 'go' });
    expect(read()).toEqual({ scripts: { run: 'go' } });
  });

  it('round-trips through resolveScripts', () => {
    saveProjectFile(dir, { setup: 's', run: 'r' });
    expect(resolveScripts(dir)).toEqual({ setup: { command: 's', source: 'klaud.json' }, run: { command: 'r', source: 'klaud.json' } });
  });
});

describe('scriptEnv', () => {
  it('sets klaud and conductor variables', () => {
    expect(scriptEnv({ path: '/w', name: 'tokyo', projectRoot: '/p', branch: 'feat/x' })).toEqual({
      KLAUD_WORKSPACE_PATH: '/w',
      KLAUD_WORKSPACE_NAME: 'tokyo',
      KLAUD_ROOT_PATH: '/p',
      KLAUD_BRANCH: 'feat/x',
      CONDUCTOR_WORKSPACE_PATH: '/w',
      CONDUCTOR_WORKSPACE_NAME: 'tokyo',
      CONDUCTOR_ROOT_PATH: '/p',
    });
  });

  it('omits KLAUD_BRANCH without a branch', () => {
    expect(Object.keys(scriptEnv({ path: '/w', name: 'n', projectRoot: '/p' })).sort()).toEqual(
      ['CONDUCTOR_ROOT_PATH', 'CONDUCTOR_WORKSPACE_NAME', 'CONDUCTOR_WORKSPACE_PATH', 'KLAUD_ROOT_PATH', 'KLAUD_WORKSPACE_NAME', 'KLAUD_WORKSPACE_PATH'],
    );
  });
});
