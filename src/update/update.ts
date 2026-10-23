import { type Run, type Status, compareVersions, decide, fetchLatest, installRoot, installedName, installedVersion, isGitCheckout, isGlobalNpmInstall, latestOnNpm, NPM_PACKAGE, makeRun, readStatus } from './check.js';
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

/**
 * Installed with `npm install -g beluga-code` (or the older klaudcode): ask npm for a newer version and
 * install it. A klaudcode install moves to beluga-code: the old package goes first (its `klaud` command
 * would clash with beluga-code's), and comes back as it was if beluga-code doesn't install.
 */
async function updateFromNpm(out: Out, run: Run, root: string, checkOnly: boolean): Promise<number> {
  const current = installedVersion(root);
  try {
    if (!(await isGlobalNpmInstall(run, root))) {
      line(out, `${ink.warn('!')} ${ink.text(`Beluga in ${root} is part of another project, so update it there (npm install ${NPM_PACKAGE}@latest).`)}`);
      line(out);
      return 1;
    }
    const latest = await step(out, 'Checking npm for a newer Beluga', () => latestOnNpm(run), (v) => `Latest on npm: ${v}`);
    if (compareVersions(latest, current) <= 0) {
      line(out);
      line(out, `${ink.ok('●')} ${ink.text(`You're on the latest Beluga (${current})`)}`);
      line(out);
      return 0;
    }
    line(out);
    line(out, `${ink.info('●')} ${ink.text(`Beluga ${latest} is available`)} ${ink.muted(`you have ${current}`)}`);
    line(out, `  ${ink.muted('What changed:')} ${ink.text('https://github.com/kayraucklnc/beluga/releases')}`);
    line(out);
    if (checkOnly) {
      line(out, `${ink.muted('Run')} ${ink.text('beluga update')} ${ink.muted('to install.')}`);
      line(out);
      return 0;
    }
    const npmInstall = (spec: string) => run('npm', ['install', '-g', '--no-audit', '--no-fund', '--loglevel=error', spec]);
    const legacy = installedName(root) !== NPM_PACKAGE ? installedName(root) : undefined;
    if (legacy) await step(out, `Removing ${legacy} (Beluga's old name on npm)`, () => run('npm', ['uninstall', '-g', '--loglevel=error', legacy]), () => `Removed ${legacy}`);
    await step(
      out,
      `Installing Beluga ${latest}`,
      () => npmInstall(`${NPM_PACKAGE}@${latest}`).catch(async (err: unknown) => {
        // Never leave you with neither: the old package goes back as it was.
        if (legacy) await npmInstall(`${legacy}@${current}`).catch(() => undefined);
        throw err;
      }),
      () => `Installed Beluga ${latest}`,
    );
    line(out);
    await bar(out, 'finishing');
    line(out, `${ink.ok('●')} ${ink.text(`Beluga ${latest} is installed`)} ${ink.muted(`${current} → ${latest}`)}`);
    line(out, `  ${ink.muted('Start it with')} ${ink.text('beluga')}`);
    line(out);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    line(out);
    line(out, `${ink.error('✗')} ${ink.text("Couldn't update:")} ${ink.muted(message)}`);
    line(out, `  ${ink.muted(/EACCES|permission/i.test(message) ? 'Your global npm folder needs admin rights. Try:' : 'Update by hand:')} ${ink.text(`${/EACCES|permission/i.test(message) ? 'sudo ' : ''}npm install -g ${NPM_PACKAGE}@latest`)}`);
    line(out);
    return 1;
  }
}

/** `beluga update`: check GitHub for a newer Beluga and install it in place. Returns the exit code. */
export async function runUpdate(opts: UpdateOptions = {}): Promise<number> {
  const out = opts.out ?? stdout;
  const root = opts.root ?? installRoot();
  const run = opts.run ?? makeRun(root);
  await title(out, opts.checkOnly ? 'update check' : 'update');

  if (!(await isGitCheckout(run, root))) return updateFromNpm(out, run, root, opts.checkOnly === true);

  try {
    await step(out, 'Checking GitHub for a newer Beluga', () => fetchLatest(run), () => 'Checked GitHub');
    const status = await readStatus(run);
    const decision = decide(status);

    if (decision.kind === 'latest') {
      line(out);
      line(out, `${ink.ok('●')} ${ink.text(`You're on the latest Beluga (${installedVersion(root)})`)} ${ink.muted(`${status.head} · ${status.branch}`)}`);
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
      line(out, `${ink.muted('Run')} ${ink.text('beluga update')} ${ink.muted('to install.')}`);
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
    line(out, `${ink.ok('●')} ${ink.text(`Beluga ${installedVersion(root)} is installed`)} ${ink.muted(`${status.head} → ${head}`)}`);
    line(out, `  ${ink.muted('Start it with')} ${ink.text('beluga')}`);
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
