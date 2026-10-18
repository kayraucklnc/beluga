import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { klaudHome } from '../workspaces/store.js';
import type { Template } from './work-store.js';
export { cursorFor } from '../shared/templates-text.js';

/** Ready-made ways to start common tasks. Your own templates are listed after these. */
export const BUILT_IN_TEMPLATES: readonly Template[] = [
  { id: 'fix-ci', name: 'Fix failing CI', prompt: 'CI is failing on this branch. Find out why (gh run list / gh run view --log-failed), fix it, run the tests locally, and commit the fix.', builtIn: true },
  { id: 'add-tests', name: 'Add tests', prompt: 'Add tests for ', builtIn: true },
  { id: 'bug', name: 'Fix a bug', prompt: 'There is a bug: . Reproduce it with a failing test first, then fix it and make sure all tests pass.', builtIn: true },
  { id: 'feature', name: 'Build a feature', prompt: 'Build this feature: . Look at how similar things are done in this codebase first, keep the change focused, add tests, and update the docs if needed.', plan: true, builtIn: true },
  { id: 'refactor', name: 'Refactor', prompt: 'Refactor  to be simpler and easier to read without changing behavior. Run the tests before and after.', builtIn: true },
  { id: 'deps', name: 'Update dependencies', prompt: 'Update the dependencies to their latest compatible versions, fix anything that breaks, and run the tests. List what changed.', builtIn: true },
  { id: 'explain', name: 'Explain this codebase', prompt: 'Explain how this codebase is organized: the main parts, how a request flows through them, and where to start reading. Keep it short.', builtIn: true },
  { id: 'review-pr', name: 'Review a pull request', prompt: 'Review pull request # (use gh pr checkout and gh pr diff). Check correctness, security, tests and readability, and list issues by severity with file:line.', builtIn: true },
];

const SavedTemplate = z.object({ id: z.string().max(40), name: z.string().trim().min(1).max(60), prompt: z.string().trim().min(1).max(8000), plan: z.boolean().optional() });

export const templatesFile = (): string => path.join(klaudHome(), 'templates.json');

export function loadTemplates(file = templatesFile()): Template[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    // One broken entry shouldn't take the others with it.
    const saved = (Array.isArray(raw) ? raw : []).slice(0, 100).flatMap((t) => {
      const parsed = SavedTemplate.safeParse(t);
      return parsed.success ? [parsed.data] : [];
    });
    return [...BUILT_IN_TEMPLATES, ...saved];
  } catch {
    return [...BUILT_IN_TEMPLATES];
  }
}

function saveCustom(list: readonly Template[], file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(list.filter((t) => !t.builtIn).map(({ id, name, prompt, plan }) => ({ id, name, prompt, ...(plan ? { plan } : {}) })), null, 2)}\n`);
  renameSync(tmp, file);
}

/** Save a new template ("name: prompt" style input is split by the caller). */
export function addTemplate(name: string, prompt: string, plan = false, file = templatesFile()): Template[] {
  const list = loadTemplates(file);
  if (!name.trim() || !prompt.trim()) return list;
  const template: Template = { id: randomUUID().slice(0, 8), name: name.trim().slice(0, 60), prompt: prompt.trim().slice(0, 8000), ...(plan ? { plan } : {}) };
  const next = [...list.filter((t) => t.builtIn || t.name.toLowerCase() !== template.name.toLowerCase()), template];
  saveCustom(next, file);
  return next;
}

export function removeTemplate(id: string, file = templatesFile()): Template[] {
  const next = loadTemplates(file).filter((t) => t.builtIn || t.id !== id);
  saveCustom(next, file);
  return next;
}

