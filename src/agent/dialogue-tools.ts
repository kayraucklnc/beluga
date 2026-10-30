import path from 'node:path';
import { z } from 'zod';
import { isReadOnlyCommand } from './read-only.js';
import { tool } from './tool-kit.js';

/**
 * One turn of a chaired dialogue (core/dialogues): what the agent is told about it (appended to
 * its instructions) and its end_dialogue tool, mounted on the room's `beluga` server for that
 * turn only.
 */
export interface DialogueTurnTools {
  readonly brief: string;
  /** A talk or cross-reference: the turn only looks, so a runtime that confines itself (Codex) writes nowhere. */
  readonly readOnly?: boolean;
  /** The agent says the dialogue is done: the chair ends it after this turn. Answers in words. */
  end(reason: string): string;
}

export const END_DIALOGUE_TOOL = 'mcp__beluga__end_dialogue';

export function endDialogueToolDef(dialogue: DialogueTurnTools) {
  return tool(
    'end_dialogue',
    'End this dialogue: call it when the question is settled, you agree, or more turns would only repeat. Then finish your turn with your last word.',
    { reason: z.string().min(1).max(500).describe('Why it ends, in one line (shown in the thread)') },
    async (a) => {
      try {
        return { content: [{ type: 'text' as const, text: dialogue.end(a.reason) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    },
  );
}

/** Tools a talk-mode turn may use: they look, never change (plus ending the dialogue). */
const LOOK_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'ToolSearch', END_DIALOGUE_TOOL, 'mcp__beluga__list_peers']);

export const TALK_READ_ONLY_REASON = "Beluga blocked this: this is a talk dialogue, which is read-only (nothing may change). Answer in words; don't try another way to change anything.";

/**
 * Talk mode's vetTool: everything that isn't plainly a look is denied (an allow-list, so a tool
 * nobody thought of can't write either). Bash only when the command only reads (agent/read-only.ts).
 */
export function talkReadOnly(toolName: string, input: Record<string, unknown>): string | undefined {
  if (LOOK_TOOLS.has(toolName)) return undefined;
  if (toolName === 'Bash' && typeof input.command === 'string' && isReadOnlyCommand(input.command)) return undefined;
  return TALK_READ_ONLY_REASON;
}

/** File tools that write, and the input naming their file. */
const WRITES: Readonly<Record<string, string>> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };

export const WORK_OUTSIDE_REASON = "Beluga blocked this: a work dialogue changes files in its one worktree only. Don't try another way; work inside it.";

/**
 * Work mode's vetTool: the full tools, but files change only inside the dialogue's worktree (the
 * run's scope keeps everything else asking or refused too). A relative path is the worktree's.
 */
export function workConfined(worktree: string): (toolName: string, input: Record<string, unknown>) => string | undefined {
  const root = path.resolve(worktree);
  return (toolName, input) => {
    const field = WRITES[toolName];
    if (!field) return undefined;
    const raw = input[field];
    if (typeof raw !== 'string' || !raw) return WORK_OUTSIDE_REASON;
    const target = path.resolve(root, raw);
    return target === root || target.startsWith(root + path.sep) ? undefined : WORK_OUTSIDE_REASON;
  };
}
