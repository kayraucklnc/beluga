import { z } from 'zod';
import { DashboardPatchSchema, TileInputSchema, TilePatchSchema } from '../core/sentinel/schema.js';

/**
 * Dashboards in the API (see api.ts; docs/sentinel.md §10): the Mac app's Dashboard page, and the
 * phone's Refresh. Tiles name a sentinel and a metric, never a source. Browser-safe: zod only.
 */

const id = z.string().min(1).max(80);

export const DASHBOARD_API = {
  // A new, empty dashboard (a tab) → the dashboard.
  'dashboard.create': { args: z.tuple([z.string().trim().min(1).max(60)]) },
  // Rename it, or change what every tile compares with → the dashboard.
  'dashboard.update': { args: z.tuple([id, DashboardPatchSchema]) },
  'dashboard.remove': { args: z.tuple([id]) },
  // Add a Tile (at a place, or last) → { dashboard, tile }.
  'dashboard.addTile': { args: z.tuple([id, TileInputSchema, z.number().int().min(0).max(1000).optional()]) },
  // A tile's width, title, chart, metrics or pinned compare (null: the dashboard's) → the dashboard.
  'dashboard.updateTile': { args: z.tuple([id, id, TilePatchSchema]) },
  'dashboard.removeTile': { args: z.tuple([id, id]) },
  // Dragged into place: the tile goes to that index among the others → the dashboard.
  'dashboard.moveTile': { args: z.tuple([id, id, z.number().int().min(0).max(1000)]) },
  // Refresh: Run Now on each sentinel it draws from, one at a time (the state says how far) → { total }.
  'dashboard.refresh': { args: z.tuple([id]) },
  // Describe it: your Claude builds it from your words → { channel }.
  'dashboard.ask': { args: z.tuple([id, z.string().trim().min(1).max(8000)]) },
} as const;
