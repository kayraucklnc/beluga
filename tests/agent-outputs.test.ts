import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachClaudeCode } from '../src/core/claude-code/launch.js';
import { ClaudeCodeWatcher } from '../src/core/claude-code/watch.js';
import { Store, initialState } from '../src/core/store.js';
import type { Session } from '../src/core/session.js';
import { CLAUDE_CODE_HANDLERS } from '../src/ipc/claude-code-handlers.js';
import { parseArgs } from '../src/ipc/api.js';
import { MAX_OUTPUTS, MAX_RESULT_PATHS, OutputLog, isArtifact, outputKind, pathsInText, refsOfTool } from '../src/core/claude-code/outputs.js';
import { AGENT_SCRATCH_DIR, agentScratchName } from '../src/shared/scratch-dir.js';
import { withAgentScratch } from '../src/agent/subagents.js';

const CWD = '/work/app';
const TS = 1000;

describe('what counts as something an agent made', () => {
  it('pictures, PDFs and videos anywhere; notes and logs only where outputs go', () => {
    expect(isArtifact('/tmp/shot.png', CWD)).toBe(true);
    expect(isArtifact(`${CWD}/assets/logo.png`, CWD)).toBe(true);
    expect(isArtifact('/tmp/report.pdf', CWD)).toBe(true);
    expect(isArtifact('/tmp/run.webm', CWD)).toBe(true);
    // Text outside the project: an output. Inside it: source, unless it's where outputs go.
    expect(isArtifact('/tmp/test.log', CWD)).toBe(true);
    expect(isArtifact('/private/var/folders/x/T/out.json', CWD)).toBe(true);
    expect(isArtifact(`${CWD}/README.md`, CWD)).toBe(false);
    expect(isArtifact(`${CWD}/package.json`, CWD)).toBe(false);
    expect(isArtifact(`${CWD}/.beluga/scratch/notes.md`, CWD)).toBe(true);
    expect(isArtifact(`${CWD}/test-results/run/error-context.md`, CWD)).toBe(true);
    expect(isArtifact(`${CWD}/coverage/summary.txt`, CWD)).toBe(true);
    expect(isArtifact(`${CWD}/.context/screens.json`, CWD)).toBe(true);
    // Code is never an output; neither is anything in node_modules or .git.
    expect(isArtifact('/tmp/a.ts', CWD)).toBe(false);
    expect(isArtifact(`${CWD}/node_modules/x/shot.png`, CWD)).toBe(false);
    expect(isArtifact(`${CWD}/.git/x.png`, CWD)).toBe(false);
    expect(isArtifact('relative.png', CWD)).toBe(false);
  });

  it('knows the kind of a file by its name', () => {
    expect(outputKind('/a/b.PNG')).toBe('image');
    expect(outputKind('/a/b.pdf')).toBe('pdf');
    expect(outputKind('/a/b.webm')).toBe('video');
    expect(outputKind('/a/b.json')).toBe('json');
    expect(outputKind('/a/b.md')).toBe('markdown');
    expect(outputKind('/a/b.log')).toBe('text');
  });
});

describe('outputs from tool calls', () => {
  it('files it wrote or looked at', () => {
    expect(refsOfTool('Write', { file_path: '/tmp/shot.png' }, CWD, TS)).toEqual([{ path: '/tmp/shot.png', how: 'wrote', ts: TS }]);
    expect(refsOfTool('Write', { file_path: `${CWD}/src/a.ts` }, CWD, TS)).toEqual([]);
    expect(refsOfTool('Read', { file_path: '/tmp/test.log' }, CWD, TS)).toEqual([{ path: '/tmp/test.log', how: 'read', ts: TS }]);
    expect(refsOfTool('Read', { file_path: 'shots/a.png' }, CWD, TS)).toEqual([{ path: `${CWD}/shots/a.png`, how: 'read', ts: TS }]);
  });

  it('where a command sends its output, and files a command names', () => {
    expect(refsOfTool('Bash', { command: 'npm test > /tmp/test.log 2>&1' }, CWD, TS)).toEqual([{ path: '/tmp/test.log', how: 'ran', ts: TS }]);
    expect(refsOfTool('Bash', { command: 'npx vitest run | tee -a out/run.txt' }, CWD, TS)).toEqual([{ path: `${CWD}/out/run.txt`, how: 'ran', ts: TS }]);
    expect(refsOfTool('Bash', { command: 'curl -s https://x.dev/api -o "/tmp/api response.json"' }, CWD, TS)).toEqual([{ path: '/tmp/api response.json', how: 'ran', ts: TS }]);
    expect(refsOfTool('Bash', { command: 'npx playwright screenshot http://localhost:3000 shots/home.png' }, CWD, TS)).toEqual([{ path: `${CWD}/shots/home.png`, how: 'ran', ts: TS }]);
    expect(refsOfTool('Bash', { command: 'screencapture -x --output=/tmp/s.png' }, CWD, TS)).toEqual([{ path: '/tmp/s.png', how: 'ran', ts: TS }]);
    // Nothing made: no files, /dev/null, or source code.
    expect(refsOfTool('Bash', { command: 'npm test 2>/dev/null' }, CWD, TS)).toEqual([]);
    expect(refsOfTool('Bash', { command: 'git status' }, CWD, TS)).toEqual([]);
    expect(refsOfTool('Bash', { command: 'cat > src/x.ts <<EOF' }, CWD, TS)).toEqual([]);
  });

  it('screenshots and files other tools save (browsers, MCP servers)', () => {
    expect(refsOfTool('mcp__playwright__browser_take_screenshot', { filename: '/tmp/pw/home.png' }, CWD, TS)).toEqual([{ path: '/tmp/pw/home.png', how: 'wrote', ts: TS }]);
    expect(refsOfTool('mcp__x__save', { outputPath: '/tmp/r.pdf', other: '/tmp/no.png' }, CWD, TS)).toEqual([{ path: '/tmp/r.pdf', how: 'wrote', ts: TS }]);
    expect(refsOfTool('Grep', { pattern: 'x', path: '/tmp' }, CWD, TS)).toEqual([]);
  });

  it('full paths of pictures, PDFs, videos and traces a result mentions', () => {
    const text = 'Took the screenshot, saved as /tmp/pw/shot-1.png.\n  attachment: /work/app/test-results/login/trace.zip\nsee "/tmp/a b.pdf" and src/x.png and /tmp/code.ts';
    expect(pathsInText(text)).toEqual(['/tmp/pw/shot-1.png', '/work/app/test-results/login/trace.zip', '/tmp/a b.pdf']);
    expect(pathsInText('x'.repeat(10))).toEqual([]);
    // Not a URL's path; not a whole folder listing.
    expect(pathsInText('see https://cdn.dev/img/a.png')).toEqual([]);
    expect(pathsInText(Array.from({ length: 50 }, (_, i) => `/pics/${i}.png`).join('\n'))).toHaveLength(MAX_RESULT_PATHS);
  });
});

describe('the outputs a transcript keeps', () => {
  it('newest mention wins; bounded', () => {
    const log = new OutputLog();
    log.add([{ path: '/tmp/a.png', how: 'wrote', ts: 1 }]);
    log.add([{ path: '/tmp/a.png', how: 'read', ts: 5 }, { path: '/tmp/b.log', how: 'ran', ts: 3 }]);
    expect(log.list()).toEqual([
      { path: '/tmp/a.png', how: 'wrote', ts: 5 },
      { path: '/tmp/b.log', how: 'ran', ts: 3 },
    ]);
    for (let i = 0; i < MAX_OUTPUTS + 10; i++) log.add([{ path: `/tmp/${i}.png`, how: 'wrote', ts: 10 + i }]);
    expect(log.list()).toHaveLength(MAX_OUTPUTS);
    expect(log.list()[0]!.path).toBe(`/tmp/${MAX_OUTPUTS + 9}.png`);
  });
});

describe("a sub-agent's own scratch folder", () => {
  it('is named after the call that started it', () => {
    expect(agentScratchName('toolu_01AbCdEf9876543210')).toBe('9876543210');
    expect(agentScratchName('call/../../x')).toBe('callx');
    expect(agentScratchName('')).toBe('agent');
    expect(AGENT_SCRATCH_DIR).toBe('.beluga/scratch/agents');
  });

  it('is handed to each sub-agent in its prompt', () => {
    const patched = withAgentScratch('Agent', { description: 'Check the UI', prompt: 'Take screenshots.' }, 'toolu_01xyz0123456789', '/work/app/.beluga/scratch');
    expect(patched?.prompt).toContain('Take screenshots.');
    expect(patched?.prompt).toContain('/work/app/.beluga/scratch/agents/0123456789/');
    expect(patched?.description).toBe('Check the UI');
    // Only sub-agent launches, only with a prompt, only once.
    expect(withAgentScratch('Bash', { command: 'ls' }, 'toolu_1', '/s')).toBeUndefined();
    expect(withAgentScratch('Task', {}, 'toolu_1', '/s')).toBeUndefined();
    expect(withAgentScratch('Task', { prompt: patched!.prompt }, 'toolu_01xyz0123456789', '/work/app/.beluga/scratch')).toBeUndefined();
  });
});

describe('the watcher: what a sub-agent made, to look at', () => {
  const SID = 'c40fea54-5cab-4cc2-9384-84792e63291d';
  const TOOL = 'toolu_01xyz0123456789';
  let root: string;
  let cwd: string;
  let tmp: string;
  let w: ClaudeCodeWatcher;
  const iso = (ms: number): string => new Date(ms).toISOString();
  const now = Date.now();
  const line = (o: unknown): string => `${JSON.stringify(o)}\n`;
  const use = (id: string, name: string, input: Record<string, unknown>, at: number) =>
    line({ type: 'assistant', timestamp: iso(at), sessionId: SID, cwd, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' } });
  const result = (id: string, text: string, at: number) =>
    line({ type: 'user', timestamp: iso(at), sessionId: SID, cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });
  const file = (p: string, body: string | Buffer, at: number): string => {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, body);
    utimesSync(p, at / 1000, at / 1000);
    return p;
  };

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-outputs-')));
    cwd = path.join(root, 'app');
    tmp = path.join(root, 'tmp');
    mkdirSync(cwd, { recursive: true });
    const home = path.join(root, 'claude');
    const folder = path.join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    const agents = path.join(folder, SID, 'subagents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(path.join(folder, `${SID}.jsonl`), line({ type: 'user', timestamp: iso(now - 5000), sessionId: SID, cwd, message: { content: 'Check the login page' } }) + use(TOOL, 'Agent', { description: 'Check login', prompt: 'x' }, now - 4000));
    writeFileSync(path.join(agents, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Check login', toolUseId: TOOL }));
    const shot = file(path.join(tmp, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]), now - 3000);
    file(path.join(tmp, 'test.log'), 'FAIL login.spec.ts\nexport ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\n', now - 2000);
    file(path.join(tmp, 'pw', 'trace-1.png'), 'png', now - 1500);
    file(path.join(cwd, '.beluga/scratch/agents/0123456789/notes.md'), '# Notes', now - 1000);
    // A link dressed up as a log, to a key; Claude Code's own login file.
    file(path.join(root, '.ssh', 'id_rsa'), 'PRIVATE KEY', now - 900);
    symlinkSync(path.join(root, '.ssh', 'id_rsa'), path.join(tmp, 'k.log'));
    file(path.join(root, '.claude.json'), '{"oauth":"x"}', now - 900);
    writeFileSync(
      path.join(agents, 'agent-a1.jsonl'),
      use('t1', 'Write', { file_path: shot, content: '' }, now - 3000) +
        use('t2', 'Bash', { command: `npx playwright test > ${tmp}/test.log 2>&1` }, now - 2500) +
        result('t2', `screenshot: ${tmp}/pw/trace-1.png`, now - 2000) +
        use('t3', 'Read', { file_path: `${tmp}/gone.png` }, now - 1800) +
        use('t4', 'Read', { file_path: `${cwd}/src/a.ts` }, now - 1700) +
        use('t5', 'Bash', { command: `ln -s ~/.ssh/id_rsa ${tmp}/k.log; cat ${tmp}/k.log > ${tmp}/k.log` }, now - 1600) +
        use('t6', 'Read', { file_path: `${root}/.claude.json` }, now - 1500),
    );
    const store = new Store(initialState('room'));
    w = new ClaudeCodeWatcher({ home, store, watch: false, publishMs: 0 });
    await w.scan();
    w.poll();
  });
  afterEach(() => {
    w.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('lists what it made or looked at that is still there, newest first, its own folder included', () => {
    const out = w.outputs(SID, 'a1');
    expect(out.scratch).toBe(path.join(cwd, '.beluga/scratch/agents/0123456789'));
    expect(out.outputs.map((o) => [path.relative(root, o.path), o.how, o.kind])).toEqual([
      ['app/.beluga/scratch/agents/0123456789/notes.md', 'wrote', 'markdown'],
      ['tmp/pw/trace-1.png', 'ran', 'image'],
      ['tmp/test.log', 'ran', 'text'],
      ['tmp/shot.png', 'wrote', 'image'],
    ]);
    expect(out.outputs[3]).toMatchObject({ size: 4, mtime: now - 3000 });
    expect(w.outputs(SID, 'nobody')).toEqual({ outputs: [], missing: true });
    expect(w.outputs('ffffffff-0000-0000-0000-000000000000', 'a1')).toEqual({ outputs: [], missing: true });
  });

  it('reads one: pictures as data, text with secrets taken out; nothing it never touched', () => {
    const shot = w.output(SID, 'a1', path.join(tmp, 'shot.png'));
    expect(shot).toMatchObject({ kind: 'image', mime: 'image/png', size: 4, data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') });
    const log = w.output(SID, 'a1', path.join(tmp, 'test.log'));
    expect(log?.text).toContain('FAIL login.spec.ts');
    expect(log?.text).not.toContain('sk-ant-api03');
    expect(w.output(SID, 'a1', path.join(cwd, 'src/a.ts'))).toBeUndefined();
    expect(w.output(SID, 'a1', '/etc/hosts')).toBeUndefined();
    expect(w.output(SID, 'a1', path.join(tmp, 'k.log'))).toBeUndefined();
    expect(w.output(SID, 'a1', path.join(root, '.claude.json'))).toBeUndefined();
  });

  it('goes through the API, arguments checked', () => {
    const s = {} as Session;
    attachClaudeCode(s, w);
    expect(CLAUDE_CODE_HANDLERS['claudeCode.outputs'](s, SID, 'a1').outputs).toHaveLength(4);
    expect(CLAUDE_CODE_HANDLERS['claudeCode.output'](s, SID, 'a1', path.join(tmp, 'shot.png'))?.kind).toBe('image');
    expect(() => parseArgs('claudeCode.output', [SID, 'a1', 'relative.png'])).toThrow();
    expect(() => parseArgs('claudeCode.outputs', [SID, '../x'])).toThrow();
  });
});
