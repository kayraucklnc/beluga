import { z } from 'zod';
import { type ChatAnswerRequest, EARLIER_MAX, READ_EARLIER_TOOL, earlierText } from '../core/chat/claude-prompt.js';
import { CompletionError, type Complete } from './runtime/types.js';
import { tool, toolSuite } from './tool-kit.js';

/** How long a chat answer may take before it's given up. */
const ANSWER_TIMEOUT_MS = 4 * 60_000;
/** Turns an answer may take when it can read earlier messages (each page read is one). */
const EARLIER_TURNS = 6;

/**
 * read_earlier (BLG-428): earlier messages of the one conversation the answer is for, a page at a
 * time. It reads only what `req.earlier` gives (core/chat/claude.ts: that conversation, up to the
 * ask, nothing locked); nothing else on this Mac.
 */
export function chatTools(earlier: NonNullable<ChatAnswerRequest['earlier']>) {
  return toolSuite({
    name: 'beluga_chat',
    version: '0.1.0',
    // In the prompt from the start: with no built-in tools there's no ToolSearch to find it by.
    alwaysLoad: true,
    tools: [
      tool(
        'read_earlier',
        'Read earlier messages of this chat, older than the ones in your prompt, newest page first. Only when what you were given isn’t enough to answer.',
        {
          before: z.union([z.string().min(1).max(200), z.number()]).optional().describe('A message id from the last page ("before: ..."), or a time in ms. Leave out for the messages just before your prompt’s.'),
          limit: z.number().int().min(1).max(EARLIER_MAX).optional().describe(`How many messages (at most ${EARLIER_MAX}).`),
        },
        async (a) => ({ content: [{ type: 'text' as const, text: earlierText(earlier({ ...(a.before !== undefined ? { before: a.before } : {}), ...(a.limit ? { limit: a.limit } : {}) })) }] }),
      ),
    ],
  });
}

/**
 * Answer in a chat (core/chat/claude.ts): no tools but read_earlier (when there's more of the
 * chat than the prompt shows), no saved session, on your own Claude login. The history and files
 * are in the prompt, so nothing on this Mac is read.
 */
export async function answerChat(req: ChatAnswerRequest, opts: { cwd: string; complete: Complete; model?: string }): Promise<string> {
  const abortController = new AbortController();
  const stop = (): void => abortController.abort();
  req.signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, ANSWER_TIMEOUT_MS);
  timer.unref();
  const model = req.model ?? opts.model;
  try {
    return await opts.complete({
      prompt: req.prompt,
      images: req.images.map((img) => ({ mime: img.mime, data: img.b64 })),
      cwd: opts.cwd,
      ...(req.earlier ? { suites: { beluga_chat: chatTools(req.earlier) }, allowedTools: [READ_EARLIER_TOOL] } : {}),
      maxTurns: req.earlier ? EARLIER_TURNS : 1,
      signal: abortController.signal,
      system: req.system,
      ...(model ? { model } : {}),
    });
  } catch (err) {
    if (abortController.signal.aborted) throw new Error(req.signal.aborted ? 'Stopped' : 'Claude took too long');
    if (err instanceof CompletionError) throw new Error(err.kind === 'max_turns' ? (req.earlier ? 'Claude read too far back without answering' : 'Claude needed more than one turn') : err.kind === 'failed' ? 'Claude couldn’t answer' : 'Claude stopped without an answer');
    throw err;
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener('abort', stop);
  }
}
