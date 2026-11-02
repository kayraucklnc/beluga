import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideTool } from '../../src/agent/policy.js';
import { secretLabel } from '../../src/core/gateway/model.js';
import { describeForClaude } from '../../src/core/gateway/result.js';
import { belugaHome } from '../../src/core/home.js';
import { isNeverSent, isReceivedTaskFile, secretKindOf } from '../../src/core/shares.js';
import type { Approval } from '../../src/core/store.js';
import { cannotTake } from '../../src/net/mesh/features.js';
import { popupButtons } from '../../packages/mac/src/gateway/popup-model.js';
import { notificationActions, outsideStep, trayRequests } from '../../packages/mac/src/gateway/request-actions.js';

/** Secrets with their own approval (BLG-209): what kind each is, what never goes, and what every screen offers. */

const home = os.homedir();

describe('what kind of secret a file is', () => {
  it('classifies keys, .env files, cloud credentials, tokens and the rest; plain files are none', () => {
    expect(secretKindOf(path.join(home, '.ssh', 'id_ed25519'))).toBe('ssh-key');
    expect(secretKindOf('/tmp/id_rsa')).toBe('ssh-key');
    expect(secretKindOf('/work/app/.env.production')).toBe('dotenv');
    expect(secretKindOf(path.join(home, '.aws', 'credentials'))).toBe('cloud');
    expect(secretKindOf(path.join(home, '.config', 'gcloud', 'application_default_credentials.json'))).toBe('cloud');
    expect(secretKindOf(path.join(home, '.npmrc'))).toBe('token');
    expect(secretKindOf(path.join(home, '.config', 'gh', 'hosts.yml'))).toBe('token');
    expect(secretKindOf('/work/certs/server.pem')).toBe('secret');
    expect(secretKindOf('/work/app/.env.example')).toBeUndefined();
    expect(secretKindOf('/work/notes.md')).toBeUndefined();
  });

  it('says it in words the approval title uses', () => {
    expect(secretLabel('ssh-key', 'id_ed25519')).toBe('your private SSH key id_ed25519');
    expect(secretLabel('ssh-key', 'config')).toBe('config from your SSH folder');
    expect(secretLabel('dotenv', '.env')).toBe('your .env file .env');
    expect(secretLabel('cloud', 'credentials')).toBe('your cloud credentials credentials');
    expect(secretLabel('token', '.npmrc')).toBe('your token file .npmrc');
    expect(secretLabel('secret', 'server.pem')).toBe('your private key server.pem');
  });

  it('Beluga’s own private files and the keychains are never sent; its task folders are yours', () => {
    expect(isNeverSent(path.join(belugaHome(), 'identity.json'))).toBe(true);
    expect(isNeverSent(path.join(belugaHome(), 'rules.json'))).toBe(true);
    expect(isNeverSent(path.join(home, 'Library', 'Keychains', 'login.keychain-db'))).toBe(true);
    expect(isNeverSent(path.join(home, '.ssh', 'id_ed25519'))).toBe(false);
    expect(isReceivedTaskFile(path.join(belugaHome(), 'tasks', 'files', 't_abcdefghijk', 'id_ed25519'))).toBe(true);
    expect(isReceivedTaskFile(path.join(belugaHome(), 'tasks', 'tasks.json'))).toBe(false);
  });
});

describe('the requester’s side', () => {
  it('an older Beluga that declines secrets is named at once', () => {
    expect(cannotTake('Ata', { version: '0.6.2+mac.1.2.0', can: ['task.ask', 'task.file'] }, 'task.secret')).toBe("Ata's Beluga 1.2.0 can't send secrets Ata approves yet. Ask Ata to update Beluga.");
    expect(cannotTake('Ata', { version: '1.3.0', can: ['task.file', 'task.secret'] }, 'task.secret')).toBeUndefined();
  });

  it('its Claude is told the owner approved it, and may read the file it saved (asking first)', () => {
    const saved = path.join(belugaHome(), 'tasks', 'files', 't_abcdefghijk', 'id_ed25519');
    const text = describeForClaude({
      id: 't_abcdefghijk',
      direction: 'sent',
      peerId: 'bob-peer-000001',
      peerName: 'bob',
      kind: 'file',
      ask: 'Send me ~/.ssh/id_ed25519',
      needs: ['files'],
      by: 'agent',
      state: 'done',
      steps: [],
      createdAt: 1,
      updatedAt: 2,
      result: { status: 'done', summary: 'id_ed25519 (1 KB)', files: [{ name: 'id_ed25519', size: 400, path: saved }], log: [], secret: 'private SSH key id_ed25519' },
    });
    expect(text).toContain('bob approved sending to your user');
    expect(text.indexOf('approved sending')).toBeLessThan(text.indexOf('<task_result'));
    const ctx = { cwd: '/tmp', roots: [], autoEdit: false, dotenv: true };
    expect(decideTool('Read', { file_path: saved }, ctx)).toBe('ask');
    // Without it (someone else's Claude), and anywhere else, a key is still refused.
    expect(decideTool('Read', { file_path: saved }, { ...ctx, dotenv: false })).toBe('deny');
    expect(decideTool('Read', { file_path: path.join(home, '.ssh', 'id_ed25519') }, ctx)).toBe('deny');
  });
});

describe('its approval offers only Allow once / Decline, everywhere', () => {
  const secret: Approval = { id: 'a1', kind: 'request', title: "kay's Claude wants your private SSH key id_ed25519", detail: '', peer: 'kay-peer-0001', task: 't_abcdefghijk', once: true };
  it('the pop-up, the menu bar and the notification have no Always', () => {
    expect(popupButtons({ kind: 'file', secret: 'your private SSH key id_ed25519' }).map((b) => b.label)).toEqual(['Decline', 'Allow Once']);
    expect(trayRequests([secret])[0]!.always).toBe(false);
    expect(notificationActions({ approval: 'a1', task: 't_abcdefghijk', once: true })).toEqual({ actionTypeId: 'beluga-review' });
    // An "Always" that comes anyway only opens it.
    expect(outsideStep('always', secret, undefined)).toEqual({ kind: 'review', task: 't_abcdefghijk' });
    expect(outsideStep('approve', secret, undefined)).toMatchObject({ kind: 'decide', decision: { answer: 'yes' } });
  });
});
