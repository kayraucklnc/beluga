import { z } from 'zod';

/**
 * Claude's steps in detail (see shared/steps.ts): a Claude card's steps, light, and one step's
 * input and output or thinking, fetched when it's opened. Only your own Claude's work has them;
 * they never leave this computer. Read-only. Browser-safe: zod only.
 */

const channel = z.string().min(1).max(200);
const itemId = z.string().min(1).max(200);
const stepId = z.string().min(1).max(200);
const version = z.number().int().min(0);

export const STEPS_API = {
  // A Claude card's steps → { steps, version, unchanged?, missing? }. `after`: the version you have.
  'agent.steps': { args: z.tuple([channel, itemId, version.optional()]) },
  // One step with its details → a StepRecord, or undefined.
  'agent.step': { args: z.tuple([channel, itemId, stepId]) },
} as const;
