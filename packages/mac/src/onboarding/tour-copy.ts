import type { IconName } from '../components/Icon.js';
import type { Step } from './onboarding-model.js';

/** The tour's words, one idea a step. Every line says what the app really does. */
export interface TourCopy {
  readonly eyebrow: string;
  readonly icon: IconName;
  readonly title: string;
  readonly body: string;
  readonly points: readonly string[];
}

export const TOUR_COPY: Readonly<Partial<Record<Step, TourCopy>>> = {
  parallel: {
    eyebrow: 'Parallel',
    icon: 'branch',
    title: 'Work on everything at once.',
    body: 'Every task gets its own worktree on its own branch, with a Claude working in it. Run as many as you like, in one repository or across all of them.',
    points: ['Worktrees and branches made for you', 'Pull requests opened and followed on GitHub', 'Sub-agents for the pieces in between'],
  },
  agents: {
    eyebrow: 'Live',
    icon: 'eye',
    title: 'See every agent work. Steer any of them.',
    body: 'Steps arrive as Claude works: the files it reads, the commands it runs, the screenshots it takes, the sub-agents and background tasks it starts. Say something mid-run and it changes course.',
    points: ['Sub-agents and background commands, live', 'Screenshots, logs and test output in one place', 'Redirect a run, or queue what comes next'],
  },
  tables: {
    eyebrow: 'In the chat',
    icon: 'table',
    title: 'Answers you can sort, not just read.',
    body: 'Ask about your data and Claude finds the database, picks the way in (Postgres, SQLite, a file, a URL), connects and runs the query. The answer comes back as a live table in the conversation.',
    points: ['Headings sort, long tables search and page', 'A table turns into a chart in a click', 'File trees, JSON, terminal output and diagrams too'],
  },
  friends: {
    eyebrow: 'Together',
    icon: 'people',
    title: 'Your Claude, and your friends’ Claudes.',
    body: 'Add friends and your Claudes work together. Yours asks theirs for what only their Mac has: a file, an account, a page they’re signed in to. They allow it, the result comes back, and yours carries on. Mac to Mac, end-to-end encrypted.',
    points: ['Files, screenshots and errands between Macs', 'You approve, or trust a friend once', 'Invite to one project, or to everything'],
  },
  earnings: {
    eyebrow: 'Earnings',
    icon: 'gauge',
    title: 'Know what every project earns.',
    body: 'Connect Stripe and each project shows its revenue right next to the work, kept up to date as sales come in.',
    points: ['A read-only key, kept on this Mac', 'Per project and per month', 'In the currency you think in'],
  },
  archive: {
    eyebrow: 'Archive',
    icon: 'archive',
    title: 'Archive without a second thought.',
    body: 'Done with a worktree? Archive it. Its folder goes, node_modules and builds with it, so your disk stays light. The branch and the whole conversation stay.',
    points: ['Folders removed, branches kept', 'Every conversation kept', 'Restore checks the branch out again'],
  },
};
