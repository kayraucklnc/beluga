import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ChatAnswerRequest } from '../core/chat/claude-prompt.js';
import { PromptQueue } from './live-run.js';

/** How long a chat answer may take before it's given up. */
const ANSWER_TIMEOUT_MS = 4 * 60_000;

/**
 * Answer in a chat (core/chat/claude.ts): one turn, no tools, no saved session, on your own
 * Claude login. The history and files are in the prompt, so nothing on this Mac is read.
 */
export async function answerChat(req: ChatAnswerRequest, opts: { cwd: string; claudePath?: string; model?: string }): Promise<string> {
  const abortController = new AbortController();
  const stop = (): void => abortController.abort();
  req.signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, ANSWER_TIMEOUT_MS);
  timer.unref();
  const prompts = new PromptQueue();
  prompts.push(
    req.images.length
      ? [
          ...req.images.map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mime as 'image/png', data: img.b64 } })),
          { type: 'text' as const, text: req.prompt },
        ]
      : req.prompt,
  );
  prompts.close();
  const model = req.model ?? opts.model;
  try {
    const q = query({
      prompt: prompts,
      options: {
        cwd: opts.cwd,
        tools: [],
        maxTurns: 1,
        settingSources: [],
        persistSession: false,
        abortController,
        systemPrompt: req.system,
        ...(model ? { model } : {}),
        ...(opts.claudePath ? { pathToClaudeCodeExecutable: opts.claudePath } : {}),
      },
    });
    for await (const msg of q) {
      if (msg.type !== 'result') continue;
      if (msg.subtype === 'success') return msg.result;
      throw new Error(msg.subtype === 'error_max_turns' ? 'Claude needed more than one turn' : 'Claude couldn’t answer');
    }
    throw new Error('Claude stopped without an answer');
  } catch (err) {
    if (abortController.signal.aborted) throw new Error(req.signal.aborted ? 'Stopped' : 'Claude took too long');
    throw err;
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener('abort', stop);
  }
}
