import { EDGE_KINDS, GRAPH_FENCE, NODE_KINDS, STATUSES } from '../shared/graph-spec.js';

/**
 * Teaching Claude to draw: the `beluga-graph` format (src/shared/graph-spec.ts) and when a graph
 * beats prose. The Mac app draws these blocks as interactive diagrams (docs/graphs.md).
 */
export function buildGraphAppend(): string {
  return [
    '',
    `Graphs: the Beluga app draws a fenced block tagged ${GRAPH_FENCE} (JSON) as an interactive diagram. Use one`,
    'whenever a picture explains better than prose: architecture, how parts talk, a request or data flow, a',
    'pipeline, a data model, dependencies, a plan, or what a change touched. When the user asks you to',
    'visualize, draw, diagram or map something, answer with a graph. The app lays it out (never give',
    'coordinates); people hover a node to see what it touches, click it for its details, and step through',
    'your walkthrough. Shape:',
    '```' + GRAPH_FENCE,
    '{"title": "How login works", "summary": "one short line", "direction": "right",',
    ' "nodes": [{"id": "web", "type": "client", "label": "Web app", "sublabel": "React · src/web"},',
    '   {"id": "api", "type": "service", "label": "API", "sublabel": "Express", "group": "backend", "status": "done",',
    '    "details": "Markdown shown when clicked", "links": [{"label": "server.ts", "href": "src/server.ts"}]},',
    '   {"id": "db", "type": "database", "label": "Postgres", "group": "backend", "fields": [{"name": "id", "type": "uuid", "key": "pk"}]},',
    '   {"id": "backend", "type": "group", "label": "Backend"}],',
    ' "edges": [{"from": "web", "to": "api", "label": "POST /login", "kind": "call"}, {"from": "api", "to": "db", "kind": "data"}],',
    ' "steps": [{"title": "1. The app asks", "text": "One or two sentences.", "focus": ["web", "api"]}]}',
    '```',
    `Node types: ${NODE_KINDS.join(', ')}. "group" is a box: other nodes set "group" to its id. A database can list`,
    '"fields"; an image node shows a screenshot ("image": its absolute path); a metric shows "value" ("87%").',
    `Edge kinds: ${EDGE_KINDS.join(', ')} (async = events and messages). Status: ${STATUSES.join(', ')}. "emphasis": true marks what matters.`,
    'Good graphs: 4 to 25 nodes, labels of 2 to 4 words with the rest in sublabel or details, real names',
    'from the code, groups for boundaries, edge labels that say what moves, emphasis on one or two things,',
    'and 3 to 7 steps when there is a story to follow. One idea per graph: two small graphs beat one crowded',
    'one. Strict JSON (no comments, no trailing commas). Ids: letters, digits and - _ . : /. Limits: label 80',
    'characters, sublabel 120, details 4000, 150 nodes, 300 edges, 30 steps. Keep the prose around a graph short.',
  ].join('\n');
}
