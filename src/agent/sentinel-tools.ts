import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { TOOL_DRAFT_SHAPE, TOOL_PATCH_SHAPE } from '../core/sentinel/tool-draft.js';
import type { SentinelTools } from './types.js';

/**
 * Sentinels as Claude's tools (server `beluga_sentinel`), in your own runs only: list them, read
 * one, set one up from what you said ("every morning…"; it starts paused), change, run, pause or
 * delete one (deleting asks you), and inside a sentinel's run, stop it when there's nothing to do.
 */

export const SENTINEL_TOOL_NAMES = ['sentinel_stop', 'sentinel_list', 'sentinel_get', 'sentinel_create', 'sentinel_run', 'sentinel_update', 'sentinel_pause', 'sentinel_remove'].map((n) => `mcp__beluga_sentinel__${n}`);

const ref = z.string().min(1).max(80).describe('The sentinel’s id (from sentinel_list) or its name');

function guarded(fn: () => string): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    return Promise.resolve({ content: [{ type: 'text', text: fn() }] });
  } catch (err) {
    return Promise.resolve({ content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true });
  }
}

export function createSentinelToolDefs(sentinel: SentinelTools) {
  const stop = sentinel.stop;
  return [
    ...(stop
      ? [
          tool(
            'sentinel_stop',
            'This sentinel run has nothing to do this time ("nothing changed since yesterday"): it ends as skipped, not failed, with your reason as its line. Call it, then end your turn with one short line.',
            { reason: z.string().min(1).max(200) },
            (a) => guarded(() => stop(a.reason)),
          ),
        ]
      : []),
    tool('sentinel_list', 'The user’s sentinels, one per line: name, when it runs, watching or paused, access, its last run and the next, and its `sentinel:<id>` link.', {}, () => guarded(() => sentinel.list())),
    tool('sentinel_get', 'One sentinel’s whole definition (its trigger, steps with their ids and fields, access, limits) as material, to change it with sentinel_update.', { id: ref }, (a) => guarded(() => sentinel.get(a.id))),
    tool(
      'sentinel_create',
      'Set up a sentinel from what the user asked for ("every weekday at 8, triage new issues into tasks"): when it runs, and its steps in order (Ask Claude with a full prompt in your own words, Run a script, Notify me). It is always made paused, and you can’t turn it on: tell the user and link it as `sentinel:<id>` (inline code) so they can check it and turn it on themselves from its page (the Mac or the phone).',
      TOOL_DRAFT_SHAPE,
      (a) => guarded(() => sentinel.create(a)),
    ),
    tool('sentinel_run', 'Run a sentinel now. Only one that is on: a paused one runs only when the user turns it on or presses Run. It runs on its own; its report shows on its page.', { id: ref }, (a) => guarded(() => sentinel.run(a.id))),
    tool(
      'sentinel_update',
      'Change a sentinel: only the fields given change (steps: the whole new list in order, keeping the ids of steps you keep or edit; sentinel_get has them). You can’t turn one on. Adding or editing a script, a service call, a pull request or a merge step, raising its access, moving it to another project, pointing a message, friend or Run another sentinel step elsewhere, or giving it a trigger of another kind or target pauses it until the user turns it on again: tell them. A change to its name, schedule times, a prompt or where it notifies doesn’t. A merge step always waits for the user’s approval: you can’t turn that off.',
      { id: ref, ...TOOL_PATCH_SHAPE },
      ({ id, ...patch }) => guarded(() => sentinel.update(id, patch)),
    ),
    tool('sentinel_pause', 'Pause a sentinel: nothing runs until the user turns it back on. You can pause one but never turn one on: that is the user’s, from the Mac or the phone.', { id: ref }, (a) => guarded(() => sentinel.pause(a.id))),
    tool('sentinel_remove', 'Delete a sentinel (only when the user asks): it stops watching and a run going now stops. The user is asked to approve it first.', { id: ref }, (a) => guarded(() => sentinel.remove(a.id))),
  ];
}

export function createSentinelTools(sentinel: SentinelTools) {
  return createSdkMcpServer({ name: 'beluga_sentinel', version: '0.1.0', tools: createSentinelToolDefs(sentinel) });
}
