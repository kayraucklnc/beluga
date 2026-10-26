import { createHash, createHmac } from 'node:crypto';
import type { GitHubRepo } from '../../workspaces/github.js';

/**
 * Comparing repositories with a friend without telling them yours (BLG-221). Each side sends, for
 * each GitHub project it has, HMAC-SHA-256(pair key, "host/owner/repo") cut to 128 bits, where the
 * pair key comes from both peer ids: the same two people get the same fingerprints, anyone else
 * (or the same repository with another friend) different ones. A friend who has the repository
 * computes the same fingerprint and sees a match; one who doesn't sees a random-looking string
 * they can't turn back into a name. What it can't hide: a friend who guesses a repository's name
 * can check that guess (it's how they'd match it if they had it).
 */

/** "github.com/acme/api": the same for https, ssh and any case. */
export const repoKey = (repo: Pick<GitHubRepo, 'host' | 'owner' | 'repo'>): string => `${repo.host}/${repo.owner}/${repo.repo}`.toLowerCase();

/** What a project's repository is called on screen: "acme/api" (with its host when it isn't github.com). */
export const repoLabel = (repo: Pick<GitHubRepo, 'host' | 'owner' | 'repo'>): string => (repo.host === 'github.com' ? `${repo.owner}/${repo.repo}` : `${repo.host}/${repo.owner}/${repo.repo}`);

/** The key two people's fingerprints are made with (either order gives the same). */
export function pairKey(a: string, b: string): Buffer {
  const [x, y] = [a, b].sort();
  return createHash('sha256').update(`beluga.team.v1\0${x}\0${y}`).digest();
}

/** A repository's fingerprint for one pair of people. */
export const fingerprint = (key: Buffer, repo: string): string => createHmac('sha256', key).update(repo).digest('hex').slice(0, 32);
