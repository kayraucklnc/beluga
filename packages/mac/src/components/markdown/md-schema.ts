import { defaultSchema } from 'rehype-sanitize';
import { ALERT_KINDS } from './md-alerts.js';

type Schema = typeof defaultSchema;

/**
 * What HTML a document may keep: GitHub's rules (no scripts, no styles, no event handlers, no
 * iframes; ids get a `user-content-` prefix), plus the classes the reader itself adds for math
 * and alerts.
 */
export const DOC_SCHEMA: Schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [['className', /^language-./, 'math-inline', 'math-display']],
    div: [...(defaultSchema.attributes?.div ?? []), ['className', 'markdown-alert', ...ALERT_KINDS.map((k) => `markdown-alert-${k}`)]],
    p: [['className', 'markdown-alert-title']],
  },
};
