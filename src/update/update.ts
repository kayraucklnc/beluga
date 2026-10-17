import { type Run, type Status, decide, fetchLatest, installRoot, installedVersion, isGitCheckout, makeRun, readStatus } from './check.js';
import { type Out, bar, ink, line, step, stdout, title } from './screen.js';

const MAX_LISTED = 8;

export interface UpdateOptions {
  /** Only report; don't install anything. */
  readonly checkOnly?: boolean;
  readonly root?: string;
  readonly run?: Run;
  readonly out?: Out;
}

function fit(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

function listIncoming(out: Out, s: Status): void {
  const room = (process.stdout.columns || 100) - 16;
  for (const c of s.incoming.slice(0, MAX_LISTED)) line(out, `  ${ink.claude('+')} ${ink.text(fit(c.subject, room))} ${ink.muted(c.sha)}`);
  if (s.incoming.length > MAX_LISTED) line(out, `    ${ink.muted(`…and ${s.incoming.length - MAX_LISTED} more`)}`);
  line(out);
}

/** `klaude update`: check GitHub for a newer klaude and install it in place. Returns the exit code. */
export async function runUpdate(opts: UpdateOptions = {}): Promise<number> {
  const out = opts.out ?? stdout;
  const root = opts.root ?? installRoot();
  const run = opts.run ?? makeRun(root);
  await title(out, opts.checkOnly ? 'update check' : 'update');

  if (!(await isGitCheckout(run, root))) {
    line(out, `${ink.warn('!')} ${ink.text(`klaude in ${root} wasn't installed from git, so it can't update itself.`)}`);
    line(out, `  ${ink.muted('Reinstall:')} ${ink.text('git clone https://github.com/kayraucklnc/klaude.git && cd klaude && npm install && npm run build && npm link')}`);
    line(out);
    return 1;
  }

  try {
    await step(out, 'Checking GitHub for a newer klaude', () => fetchLatest(run), () => 'Checked GitHub');
    const status = await readStatus(run);
    const decision = decide(status);

    if (decision.kind === 'latest') {
      line(out);
      line(out, `${ink.ok('●')} ${ink.text(`You're on the latest klaude (${installedVersion(root)})`)} ${ink.muted(`${status.head} · ${status.branch}`)}`);
      line(out);
      return 0;
    }

    line(out);
    line(out, `${ink.info('●')} ${ink.text(`${status.behind} update${status.behind === 1 ? '' : 's'} available`)} ${ink.muted(`${status.head} → ${status.upstream}`)}`);
    listIncoming(out, status);

    if (decision.kind === 'blocked') {
      line(out, `${ink.warn('!')} ${ink.text(decision.reason)}`);
      line(out);
      return 1;
    }
    if (opts.checkOnly) {
      line(out, `${ink.muted('Run')} ${ink.text('klaude update')} ${ink.muted('to install.')}`);
      line(out);
      return 0;
    }

    await step(out, 'Downloading the new version', () => run('git', ['merge', '--ff-only', '--quiet', status.upstream]), () => `Downloaded ${status.behind} change${status.behind === 1 ? '' : 's'}`);
    try {
      // npm ci installs exactly what the lockfile says and never rewrites it (which would block the next update).
      if (status.depsChanged) await step(out, 'Installing dependencies', () => run('npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error']), () => 'Dependencies installed');
      await step(out, 'Building', () => run('npm', ['run', '--silent', 'build']), () => 'Built');
    } catch (err) {
      line(out);
      line(out, `${ink.error('✗')} ${ink.text('The new version downloaded, but setting it up failed:')} ${ink.muted(err instanceof Error ? err.message : String(err))}`);
      line(out, `  ${ink.muted('Finish by hand:')} ${ink.text(`cd ${root} && npm install && npm run build`)}`);
      line(out);
      return 1;
    }
    const head = (await run('git', ['rev-parse', '--short', 'HEAD'])).trim();
    line(out);
    await bar(out, 'finishing');
    line(out, `${ink.ok('●')} ${ink.text(`klaude ${installedVersion(root)} is installed`)} ${ink.muted(`${status.head} → ${head}`)}`);
    line(out, `  ${ink.muted('Start it with')} ${ink.text('klaude')}`);
    line(out);
    return 0;
  } catch (err) {
    line(out);
    line(out, `${ink.error('✗')} ${ink.text("Couldn't update:")} ${ink.muted(err instanceof Error ? err.message : String(err))}`);
    line(out, `  ${ink.muted('Nothing was lost. Try again, or update by hand in')} ${ink.text(root)}`);
    line(out);
    return 1;
  }
}
