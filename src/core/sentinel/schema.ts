import { z } from 'zod';
import { ACCESS, BELUGA_EVENTS, GITHUB_EVENTS, NOTIFY_WHERE, SCHEDULE_EVERY, SENTRY_EVENTS, STRIPE_EVENTS } from './model.js';

/**
 * Sentinels as zod checks: what the API takes (sentinel-api.ts), what sentinel.json holds, and
 * what Claude's sentinel_create sends. Browser-safe: zod only.
 */

const id = z.string().min(1).max(80);
const text = (max: number) => z.string().max(max);
export const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time like 07:00');

export const ScheduleTriggerSchema = z.object({
  kind: z.literal('schedule'),
  every: z.enum(SCHEDULE_EVERY),
  at: HHMM.default('07:00'),
  hours: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(6), z.literal(12)]).optional(),
  days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  day: z.number().int().min(1).max(28).optional(),
  missed: z.enum(['catch-up', 'skip']).default('catch-up'),
});

export const TriggerSchema = z.discriminatedUnion('kind', [
  ScheduleTriggerSchema,
  z.object({ kind: z.literal('manual') }),
  z.object({ kind: z.literal('after'), sentinelId: id, on: z.enum(['success', 'failure', 'always']) }),
  z.object({ kind: z.literal('beluga'), what: z.enum(BELUGA_EVENTS), projectId: id.optional() }),
  z.object({ kind: z.literal('github'), what: z.enum(GITHUB_EVENTS), label: text(64).optional(), minutes: z.number().int().min(1).max(60).optional() }),
  z.object({ kind: z.literal('stripe'), what: z.enum(STRIPE_EVENTS) }),
  z.object({ kind: z.literal('uptime'), url: z.string().url().max(2000), minutes: z.union([z.literal(1), z.literal(5), z.literal(15)]), expect: z.number().int().min(100).max(599).optional() }),
  z.object({ kind: z.literal('sentry'), org: text(100).min(1), project: text(100).min(1), what: z.enum(SENTRY_EVENTS) }),
  z.object({ kind: z.literal('webhook'), signature: z.enum(['github', 'stripe']).optional() }),
]);

const stepId = z.string().min(1).max(40).optional();
const stepName = z.string().max(80).optional();

/** A step as given: ids and names are filled in when missing. */
export const StepInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('claude'), id: stepId, name: stepName, prompt: text(20_000), where: z.enum(['project', 'worktree', 'mac']).default('project'), model: text(80).optional(), effort: text(20).optional() }),
  z.object({ kind: z.literal('script'), id: stepId, name: stepName, command: text(4000).min(1), cwd: z.enum(['project', 'home']).default('project'), timeoutSec: z.number().int().min(1).max(3600).default(120) }),
  z.object({ kind: z.literal('notify'), id: stepId, name: stepName, title: text(200).optional(), body: text(4000).optional(), phone: z.boolean().default(false) }),
  z.object({
    kind: z.literal('http'),
    id: stepId,
    name: stepName,
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
    url: text(2000).min(1),
    headers: z.record(z.string().max(200), z.string().max(4000)).default({}),
    body: text(60_000).optional(),
    timeoutSec: z.number().int().min(1).max(600).default(30),
    preset: z.enum(['groqbot', 'slack', 'discord', 'url']).optional(),
  }),
  z.object({ kind: z.literal('pr'), id: stepId, name: stepName, draft: z.boolean().optional() }),
  z.object({ kind: z.literal('merge'), id: stepId, name: stepName, require: z.object({ checks: z.literal(true).default(true), approval: z.boolean().default(true) }).default({ checks: true, approval: true }), method: z.enum(['squash', 'merge']).default('squash') }),
  z.object({ kind: z.literal('message'), id: stepId, name: stepName, to: z.string().regex(/^(dm|group):[\w-]{1,80}$/), text: text(8000) }),
  z.object({ kind: z.literal('friend'), id: stepId, name: stepName, peerId: id, prompt: text(20_000), project: text(200).optional() }),
  z.object({ kind: z.literal('trigger'), id: stepId, name: stepName, sentinelId: id }),
]);

export const LimitsSchema = z.object({
  minutes: z.number().int().min(1).max(240),
  // 0: no limit (how the page turns a limit off again: a patch can't send undefined).
  perDay: z.number().int().min(0).max(500).optional(),
  pauseAfter: z.number().int().min(0).max(50),
});

export const SentinelDraftSchema = z.object({
  name: z.string().trim().min(1).max(80),
  icon: z.string().min(1).max(40).optional(),
  projectId: id.nullable().optional(),
  trigger: TriggerSchema.optional(),
  steps: z.array(StepInputSchema).max(20).optional(),
  access: z.enum(ACCESS).optional(),
  limits: LimitsSchema.partial().optional(),
  notify: z.enum(NOTIFY_WHERE).optional(),
  recipe: z.string().min(1).max(40).optional(),
});

export const SentinelPatchSchema = SentinelDraftSchema.omit({ recipe: true }).partial();

/** A sentinel as saved in sentinel.json: checked (it's our own file), the rest kept as it is. */
export const SavedSentinelSchema = z
  .object({
    id,
    name: z.string().min(1).max(80),
    icon: z.string().default('eye'),
    projectId: id.optional(),
    trigger: TriggerSchema,
    steps: z.array(StepInputSchema.and(z.object({ id: z.string().min(1), name: z.string() }))).default([]),
    access: z.enum(ACCESS).default('look'),
    limits: LimitsSchema.default({ minutes: 30, pauseAfter: 3 }),
    notify: z.enum(NOTIFY_WHERE).default('mac'),
    paused: z.boolean().default(true),
    pausedWhy: z.string().optional(),
    failures: z.number().int().min(0).default(0),
    lastScheduledAt: z.number().optional(),
    recipe: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .passthrough();

/** A run in the index: loosely checked. */
export const SavedRunSchema = z
  .object({
    id,
    sentinelId: id,
    by: z.string(),
    trigger: z.object({ kind: z.string(), summary: z.string() }).passthrough(),
    state: z.enum(['queued', 'running', 'needs-you', 'done', 'skipped', 'failed', 'stopped']),
    startedAt: z.number(),
    headline: z.string().default(''),
    steps: z.array(z.object({ id: z.string(), state: z.string() }).passthrough()).default([]),
    tasks: z.array(z.string()).default([]),
  })
  .passthrough();

export const SentinelFileSchema = z.object({
  version: z.literal(1),
  runAtOnce: z.number().int().min(1).max(6).default(2),
  items: z.array(z.unknown()).default([]),
  runs: z.array(z.unknown()).default([]),
});
