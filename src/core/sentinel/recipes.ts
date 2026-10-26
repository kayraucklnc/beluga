import type { Recipe } from './model.js';

/**
 * Built-in recipes (docs/sentinel.md §6): a sentinel filled in with a good prompt you can change.
 * Opening one makes a paused sentinel; project-less ones go to Your Mac (the window asks for a
 * project when one is needed). Phase 1 has the ones its steps can run; the rest come with them.
 */

export const RECIPES: readonly Recipe[] = [
  {
    id: 'morning-brief',
    name: 'Morning brief',
    icon: 'calendar',
    line: 'Every morning, what changed and what needs you first, on your phone',
    sentinel: {
      name: 'Morning brief',
      icon: 'calendar',
      recipe: 'morning-brief',
      trigger: { kind: 'schedule', every: 'day', at: '07:00', missed: 'catch-up' },
      access: 'look',
      notify: 'both',
      steps: [
        {
          kind: 'claude',
          name: 'Read what changed',
          where: 'project',
          prompt: [
            'Write my morning brief for {{project}} ({{date}}).',
            '',
            'Look at what changed since yesterday morning: commits on the default branch (`git log --since="24 hours ago"`), pull requests opened, merged or waiting for review (`gh pr list`), new or updated GitHub issues (`gh issue list`), the latest CI runs (`gh run list --limit 10`), and the open tasks:',
            '{{tasks}}',
            '',
            'Start with what needs me first (a failing check, a review someone waits on, an urgent task), then what moved, then what is next. Short bullets, links as task chips or URLs. If nothing changed, say so in one line and stop.',
          ].join('\n'),
        },
        { kind: 'notify', name: 'Tell me', phone: true },
      ],
    },
  },
  {
    id: 'nightly-tests',
    name: 'Nightly tests',
    icon: 'check',
    line: 'Every night the tests run; when they fail, Claude finds out why',
    sentinel: {
      name: 'Nightly tests',
      icon: 'check',
      recipe: 'nightly-tests',
      trigger: { kind: 'schedule', every: 'day', at: '02:00', missed: 'skip' },
      access: 'work',
      notify: 'mac',
      steps: [
        { kind: 'script', name: 'Run the tests', command: 'npm test', cwd: 'project', timeoutSec: 900 },
        { kind: 'notify', name: 'Tell me', title: '{{sentinel}}: the tests pass', body: 'Every test passed overnight.', phone: false },
      ],
    },
  },
  {
    id: 'dependency-updates',
    name: 'Dependency updates',
    icon: 'refresh',
    line: 'Every Monday, dependencies updated within their ranges, tests run',
    sentinel: {
      name: 'Dependency updates',
      icon: 'refresh',
      recipe: 'dependency-updates',
      trigger: { kind: 'schedule', every: 'week', at: '06:00', days: [1], missed: 'catch-up' },
      access: 'work',
      notify: 'mac',
      steps: [
        {
          kind: 'claude',
          name: 'Update and test',
          where: 'worktree',
          prompt: [
            'Update this project’s dependencies within the ranges its manifest allows (for npm: `npm outdated`, then `npm update`; use the project’s own package manager and lockfile).',
            'Run the tests and the type check. If something breaks, fix it when the fix is small and clear; otherwise put that one dependency back and say why.',
            'Commit what works with a message listing what moved. Note anything with a major version waiting (breaking changes, what it would take). If everything is current, say so and stop.',
          ].join('\n'),
        },
        { kind: 'notify', name: 'Tell me', phone: false },
      ],
    },
  },
  {
    id: 'release-notes',
    name: 'Release notes',
    icon: 'tag',
    line: 'Every Friday, release notes from the week’s merged work',
    sentinel: {
      name: 'Release notes',
      icon: 'tag',
      recipe: 'release-notes',
      trigger: { kind: 'schedule', every: 'week', at: '17:00', days: [5], missed: 'catch-up' },
      access: 'look',
      notify: 'mac',
      steps: [
        {
          kind: 'claude',
          name: 'Write the notes',
          where: 'project',
          prompt: [
            'Write release notes for {{project}} for the week up to {{date}}.',
            '',
            'Use the pull requests merged in the last 7 days (`gh pr list --state merged --search "merged:>=$(date -v-7d +%Y-%m-%d)"`, or `git log --since="7 days ago" --merges` without GitHub) and the tasks done this week.',
            'Group them as New, Better and Fixed, one line each in plain words a user understands, in the voice of the project’s README and earlier notes (CHANGELOG.md if there is one). Leave out internal chores. If nothing shipped, say so in one line.',
          ].join('\n'),
        },
        { kind: 'notify', name: 'Tell me', phone: false },
      ],
    },
  },
  {
    id: 'issues-to-tasks',
    name: 'Issues to tasks',
    icon: 'issue',
    line: 'Every morning, new GitHub issues become Ready tasks',
    sentinel: {
      name: 'Issues to tasks',
      icon: 'issue',
      recipe: 'issues-to-tasks',
      trigger: { kind: 'schedule', every: 'day', at: '08:00', missed: 'catch-up' },
      access: 'look',
      notify: 'mac',
      steps: [
        {
          kind: 'claude',
          name: 'Triage new issues',
          where: 'project',
          prompt: [
            'Read the GitHub issues opened or reopened in the last day (`gh issue list --search "created:>=$(date -v-1d +%Y-%m-%d)" --json number,title,labels,body,url`).',
            '',
            'For each real one (a bug, a request someone can act on), make a task with task_create: a short title in your own words, the goal and what done means, the issue’s URL in the context, a priority, status todo, and a label for its kind (bug, feature, docs).',
            'Skip duplicates of open tasks (these are open now):',
            '{{tasks}}',
            'Skip spam, questions answered already, and anything without enough to act on (say which). If there are no new issues, say so and stop.',
          ].join('\n'),
        },
        { kind: 'notify', name: 'Tell me', phone: false },
      ],
    },
  },
];

export const recipeById = (id: string): Recipe | undefined => RECIPES.find((r) => r.id === id);
