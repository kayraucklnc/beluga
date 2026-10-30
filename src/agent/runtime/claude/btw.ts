import { query } from '@anthropic-ai/claude-agent-sdk';
import { type BtwRequest, btwPrompt } from '../../btw.js';

/** How long a side question may take before it's given up. */
const BTW_TIMEOUT_MS = 3 * 60_000;

/**
 * Answer a side question (/btw): a fork of the conversation's session, so Claude knows the whole
 * conversation, with no tools, one turn, and nothing saved, so the conversation never sees it.
 * Runs beside a live run without touching it.
 */
export async function askBtw(req: BtwRequest, opts: { claudePath?: string } = {}): Promise<string> {
  const abortController = new AbortController();
  const stop = (): void => abortController.abort();
  req.signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, BTW_TIMEOUT_MS);
  timer.unref();
  let text = '';
  try {
    const q = query({
      prompt: btwPrompt(req.question),
      options: {
        cwd: req.cwd,
        ...(req.resume ? { resume: req.resume, forkSession: true } : {}),
        tools: [],
        maxTurns: 1,
        settingSources: [],
        persistSession: false,
        includePartialMessages: true,
        abortController,
        ...(req.model ? { model: req.model } : {}),
        ...(opts.claudePath ? { pathToClaudeCodeExecutable: opts.claudePath } : {}),
      },
    });
    for await (const msg of q) {
      if (msg.type === 'stream_event') {
        const ev = msg.event;
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          text += ev.delta.text;
          req.onText(text);
        }
        continue;
      }
      if (msg.type !== 'result') continue;
      if (msg.subtype === 'success') return msg.result || text;
      throw new Error(text ? 'Claude stopped before it finished' : 'Claude couldn’t answer that');
    }
    if (text) return text;
    throw new Error('Claude stopped without an answer');
  } catch (err) {
    if (abortController.signal.aborted) throw new Error(req.signal.aborted ? 'Stopped' : 'Claude took too long');
    throw err;
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener('abort', stop);
  }
}
