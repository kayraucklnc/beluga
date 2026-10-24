import { createHash } from 'node:crypto';
import { BRIEF_SECTIONS, type BriefSection, type Issue, SECTION_INFO, type SyncedPrints } from '../model.js';
import type { IssueFields, RemoteIssue } from './provider.js';

/**
 * The fields sync keeps in step, how a brief reads as one Markdown description (and back), and
 * the short fingerprints a link keeps of both sides, so the next sync can tell which side changed
 * a field since they last agreed.
 */

export const SYNCED = ['title', 'description', 'status', 'priority', 'estimate', 'due', 'labels', 'parent'] as const;
export type SyncedField = (typeof SYNCED)[number];

/**
 * The brief as one description: the goal first, as it is, then each other section under its
 * heading ("## Acceptance criteria"). Empty sections are left out.
 */
export function briefToMarkdown(brief: Issue['brief']): string {
  return BRIEF_SECTIONS.flatMap((s) => {
    const text = brief[s]?.trim();
    if (!text) return [];
    return s === 'goal' ? [text] : [`## ${SECTION_INFO[s].label}\n\n${text}`];
  }).join('\n\n');
}

const HEADINGS = new Map<string, BriefSection>(BRIEF_SECTIONS.map((s) => [SECTION_INFO[s].label.toLowerCase(), s]));

/**
 * A description back into the brief: text under a section's heading goes in that section,
 * everything else (before any heading, or under headings of its own) in the goal.
 */
export function markdownToBrief(markdown: string): Partial<Record<BriefSection, string>> {
  const parts: Partial<Record<BriefSection, string[]>> = {};
  let at: BriefSection = 'goal';
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const heading = /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line);
    const section = heading ? HEADINGS.get(heading[1]!.toLowerCase()) : undefined;
    if (section) {
      at = section;
      continue;
    }
    (parts[at] ??= []).push(line);
  }
  return Object.fromEntries(
    BRIEF_SECTIONS.flatMap((s) => {
      const text = parts[s]?.join('\n').trim();
      return text ? [[s, text]] : [];
    }),
  );
}

/** A task's fields as sync sends them; `parent`: its parent's id in the tracker, if linked. */
export function fieldsOf(issue: Issue, parent: string | undefined): IssueFields {
  return {
    title: issue.title,
    description: briefToMarkdown(issue.brief),
    status: issue.status,
    priority: issue.priority,
    ...(issue.estimate ? { estimate: issue.estimate } : {}),
    ...(issue.due ? { due: issue.due } : {}),
    labels: issue.labels,
    ...(parent ? { parent } : {}),
  };
}

const digest = (text: string): string => (text.length <= 40 ? text : `#${createHash('sha256').update(text).digest('base64url').slice(0, 16)}`);

/** One field as a short string: equal fields, equal prints (labels in any order). */
export function printOf(field: SyncedField, f: IssueFields | RemoteIssue): string {
  switch (field) {
    case 'labels':
      return digest([...f.labels].map((l) => l.toLowerCase()).sort().join('\0'));
    case 'description':
      return digest(f.description.trim());
    case 'estimate':
      return f.estimate ? String(f.estimate) : '';
    default:
      return digest(String(f[field] ?? ''));
  }
}

export const printsOf = (f: IssueFields | RemoteIssue): SyncedPrints => Object.fromEntries(SYNCED.map((k) => [k, printOf(k, f)]));
