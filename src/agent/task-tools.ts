import { tool, toolSuite } from './tool-kit.js';
import { z } from 'zod';
import type { TaskTools } from './types.js';

/**
 * Tools a friend's task gets on this Mac when its owner allowed them (core/gateway/serve.ts):
 * a screenshot (read-only, the picture also goes back with the result) and a summary of the
 * device. They only exist in runs for a request that needed them and was let in.
 */

export const TASK_TOOL_NAMES = ['screenshot', 'device_info'].map((n) => `mcp__beluga_task__${n}`);

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

async function guarded(fn: () => Promise<Content[]>): Promise<{ content: Content[]; isError?: boolean }> {
  try {
    return { content: await fn() };
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

export function createTaskToolDefs(tools: TaskTools) {
  const defs = [];
  if (tools.screenshot) {
    const shoot = tools.screenshot;
    defs.push(
      tool(
        'screenshot',
        "Take a screenshot of this Mac's screen (the main display, or the front window of one app) to see what's on it. Read-only. The picture is also sent back to the person who asked, with your answer.",
        { app: z.string().min(1).max(80).optional().describe('Only this app’s front window (its name, e.g. "Safari"); leave out for the whole main display') },
        (a) =>
          guarded(async () => {
            const shot = await shoot(a.app);
            return [{ type: 'text', text: shot.text }, ...(shot.image ? [{ type: 'image' as const, data: shot.image.data, mimeType: shot.image.mimeType }] : [])];
          }),
      ),
    );
  }
  if (tools.deviceInfo) {
    const info = tools.deviceInfo;
    defs.push(tool('device_info', 'A summary of this Mac: macOS version, model, processor, memory, disk space, battery, local network addresses and installed apps. No secrets.', {}, () => guarded(async () => [{ type: 'text', text: await info() }])));
  }
  return defs;
}

/** The MCP server with those tools (none: undefined). */
export function createTaskTools(tools: TaskTools) {
  const defs = createTaskToolDefs(tools);
  return defs.length ? toolSuite({ name: 'beluga_task', version: '0.1.0', tools: defs }) : undefined;
}
