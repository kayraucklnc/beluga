/**
 * Experimental features (Settings › Experimental): early work that's off until you turn it on.
 * One list for the daemon (what Claude is told, what the API allows) and the screens (the pane
 * that explains each one). Browser-safe: data only.
 */

export const EXPERIMENTS = ['previews', 'toolSearch'] as const;
export type Experiment = (typeof EXPERIMENTS)[number];

export interface ExperimentInfo {
  readonly id: Experiment;
  readonly title: string;
  /** One sentence: what it is. */
  readonly summary: string;
  /** What changes in Beluga while it's on, a line each. */
  readonly changes: readonly string[];
  /** What it costs this computer, in plain words. */
  readonly cost: string;
  /** Other words people would search Settings with. */
  readonly keywords: string;
}

export const EXPERIMENT_INFO: Readonly<Record<Experiment, ExperimentInfo>> = {
  previews: {
    id: 'previews',
    title: 'Live previews',
    summary: 'See the React components and web pages your agent builds, drawn live in the chat, and play with them there.',
    changes: [
      'Your agent can show a component it made or changed as a live preview in its answer: React, Vue or Svelte, a web page, or your own dev server.',
      'Props are filled in from the component’s own types, and you can change each one beside it. What you change is kept.',
      'Tailwind, Next.js and your app’s providers work as in the app; your agent can add a small preview wrapper file for the providers.',
      'Each preview can pin hover and focus, switch to a dark canvas or a phone’s width, check accessibility and save a picture.',
      'Component files in Files get a Preview view. The preview follows the file: save it and the drawing updates in place.',
    ],
    keywords: 'preview component react render storybook page html props live',
    cost: 'Each preview is built on this computer when it scrolls into view, which takes a moment of CPU and some memory. Beluga lets it go when you look away, and while this is off nothing of it runs at all.',
  },
  toolSearch: {
    id: 'toolSearch',
    title: 'Semantic tool search',
    summary: 'Agents outside Beluga find its tools by what they mean, not only by the words they share: “get rid of that watcher” finds the tool that removes a sentinel.',
    changes: [
      'beluga_find, the search that agents outside Beluga use to reach most of its tools, ranks them with a small embedding model (bge-small) instead of only matching words. It helps most with agents that search in their own words, such as local models.',
      'Beluga’s own agents don’t change: they get their tools from their harness.',
      'Until it’s ready, and if anything fails, beluga_find keeps its built-in search and says why once.',
      'An agent can’t turn this on by itself: a change of settings asks you first.',
    ],
    keywords: 'tool search semantic embeddings beluga_find external agents mcp ratel local model ollama',
    cost: 'Turning it on downloads about 4 MB of packages (Ratel’s SDK, from npm) and a 134 MB model (from Hugging Face), each checked against a fingerprint built into Beluga, into ~/.beluga/tool-search. Getting ready then takes a minute or two of CPU once; later starts take about a second. Searches run on this computer, and nothing about them leaves it. Turning it off deletes the folder.',
  },
};

/** Whether an experiment is on in a list of enabled ones (unknown ids from a newer Beluga are kept, never on). */
export function experimentOn(enabled: readonly string[] | undefined, id: Experiment): boolean {
  return Boolean(enabled?.includes(id));
}

/** The list with `id` turned on or off (a new list; order kept). */
export function withExperiment(enabled: readonly string[], id: Experiment, on: boolean): string[] {
  const rest = enabled.filter((e) => e !== id);
  return on ? [...rest, id] : rest;
}
