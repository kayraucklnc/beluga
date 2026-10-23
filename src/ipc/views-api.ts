import { z } from 'zod';
import { SourceSchema, ViewQuerySchema } from '../shared/view-spec.js';

/**
 * Live elements in a conversation (shared/view-spec.ts): a page of a view's source, fetched on
 * this computer. The window only asks for sources of your own Claude's answers. Browser-safe.
 */

export const VIEWS_API = {
  // A page of rows (or a code view's text) → ViewPage, or { needsApproval, what } for a command that hasn't run before.
  // `confirm`: you said yes to running it; `fresh`: fetch again (Refresh); `text`: the text itself; `cwd`: where it starts.
  'view.fetch': { args: z.tuple([SourceSchema, ViewQuerySchema, z.object({ confirm: z.boolean().optional(), fresh: z.boolean().optional(), text: z.boolean().optional(), cwd: z.string().max(4096).optional() }).optional()]) },
} as const;
