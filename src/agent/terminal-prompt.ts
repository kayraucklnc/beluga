import { GRAPH_FENCE } from '../shared/graph-spec.js';
import { visualToken } from '../shared/term-visuals.js';
import { VIEW_FENCE } from '../shared/view-spec.js';

/**
 * The agent's own terminal in Beluga (BLG-534): the conversation is the same, but what Claude
 * writes shows as text in a terminal, not drawn in the chat. Visuals go through the `show` tool,
 * whose token becomes a link that opens the real thing beside the terminal (shared/term-visuals.ts).
 */
export function buildTerminalAppend(): string {
  const token = visualToken(3);
  return [
    '',
    '',
    'You are in Beluga\'s terminal view: the user talks to you in your own terminal app inside Beluga, and',
    'what you write shows as terminal text, not drawn in the chat. The same conversation goes on in the chat',
    'when they switch back. So here:',
    `- Never write a fenced ${GRAPH_FENCE} or ${VIEW_FENCE} block, not even once (it shows as raw JSON). Show every graph,`,
    `  table, chart or other view with mcp__beluga_view__show instead (a graph: "type": "graph" with the graph's`,
    `  fields). It returns a token like ${token}: write it on a line of its own where the visual goes, exactly as`,
    '  returned. Beluga draws it as a link the user clicks to open the real, interactive visual beside the terminal.',
    '- Everything else the chat draws goes through mcp__beluga_view__show_block the same way: task cards',
    '  (a ```beluga-tasks block), code from this repository (```beluga-code), a pull request\'s comments,',
    '  a ```mermaid diagram, a picture (![name](/absolute/path.png)). Pass the Markdown as you would write it in',
    '  the chat; write the token it returns on a line of its own. The user opens it drawn exactly as the chat draws it.',
    '- For a table, add its first few rows as a small Markdown table under the token when they help, so the',
    '  terminal shows them at a glance; the link has all of them, with sorting and filters.',
    '- Task keys (BLG-12, task:BLG-12) and absolute paths to pictures become links on their own; plain',
    '  Markdown, code blocks and tables read fine as they are.',
  ].join('\n');
}
