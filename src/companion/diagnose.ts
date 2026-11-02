import type { DialAttempt, LinkPath } from './protocol.js';

/**
 * Saying what went wrong with the link in plain words, and what to do (docs/companion.md, "When
 * it can't connect"). The phone shows `title` and `body` on the surface and the rest in its "Why?"
 * sheet; the Mac's Settings › Phone uses `pathNote`. Pure and runtime-free: the app, the worklet
 * and the Mac all import it. Never a raw error code on the surface (only in `detail`).
 */

export type Problem =
  /** The phone itself has no internet. */
  | 'offline'
  /** The phone's network blocks the DHT (UDP), and the relay didn't help either. */
  | 'dht-blocked'
  /** The Mac was found, but this network won't let them connect, and the relay failed too. */
  | 'no-path'
  /**
   * The Mac was found but couldn't be reached directly, and its relay didn't answer (or it had none
   * yet): it's restarting it by itself (BLG-126), so the phone keeps trying without being asked.
   */
  | 'relay-down'
  /** The Mac isn't online: asleep, Beluga closed, or its network is off. */
  | 'mac-offline'
  /** The pairing isn't open any more (10 minutes, one phone) or was closed on the Mac. */
  | 'pairing-gone'
  /** The code or link didn't check out. */
  | 'pairing-wrong'
  /** The Mac has as many phones as it takes. */
  | 'pairing-full'
  /** Another phone is pairing right now. */
  | 'pairing-busy'
  | 'update-mac'
  | 'update-app'
  /** This phone was removed on the Mac. */
  | 'removed'
  | 'unknown';

export interface Diagnosis {
  readonly problem: Problem;
  readonly title: string;
  readonly body: string;
  /** What to do, when there's something (a sentence). */
  readonly tryThis?: string;
  /** The "Why?" sheet: what was tried and how it went, one line each. */
  readonly detail: readonly string[];
  /** Try again makes sense (no point for "update the app"). */
  readonly retry: boolean;
  /** It should fix itself: the phone keeps trying by itself while you look, and says so. */
  readonly auto?: boolean;
  readonly action?: 'pair-again' | 'update-app' | 'update-mac' | 'open-settings';
}

/** Why the Mac turned a pairing away (dev_refused `why`). */
export type PairRefusal = 'expired' | 'used' | 'cancelled' | 'unverified' | 'tries' | 'busy' | 'full' | 'version-mac' | 'version-app';

export interface DiagnoseInput {
  readonly stage: 'pair' | 'link';
  /** The phone could reach the internet at all (checked after everything failed); undefined: not checked. */
  readonly online?: boolean;
  /** What the dial tried (dial.ts DialReport). */
  readonly report?: {
    readonly tried: readonly DialAttempt[];
    readonly dht: 'ok' | 'unreachable' | 'unknown';
    readonly found: 'yes' | 'no' | 'unknown';
    readonly recordAge?: number;
    readonly removed?: boolean;
  };
  /** The link closed with this code (4002 version, 4010 removed). */
  readonly closeCode?: number;
  readonly reason?: string;
  readonly refusal?: PairRefusal;
}

const WAY: Record<DialAttempt['way'], string> = { p2p: 'Direct connection', relay: 'Relay' };
const OUTCOME: Record<DialAttempt['outcome'], string> = {
  ok: 'connected',
  timeout: 'no answer in time',
  refused: 'turned away',
  unreachable: 'found the Mac, but couldn’t connect on this network',
  'not-found': 'the Mac isn’t there',
  failed: 'failed',
  skipped: 'not tried',
  lost: 'stopped: another way connected first',
};

/** One attempt for the "Why?" sheet: "Direct connection: found the Mac, but couldn't connect on this network (2.4 s · HOLEPUNCH_ABORTED)". */
export function attemptLine(a: DialAttempt): string {
  const extras = [a.ms !== undefined ? `${(a.ms / 1000).toFixed(1)} s` : '', a.code ?? ''].filter(Boolean).join(' · ');
  return `${WAY[a.way]}: ${OUTCOME[a.outcome]}${extras ? ` (${extras})` : ''}`;
}

/** How a link came, in a few words (the phone's Settings › Advanced, the Mac's phone popover). */
export function pathLabel(path: LinkPath): string {
  if (path === 'lan') return 'Connected directly · same network';
  if (path === 'direct') return 'Connected directly · over the internet';
  return 'Connected through the relay (end-to-end encrypted)';
}

/** The Mac's sentence about a phone's last link, when there's something worth saying. */
export function pathNote(path: LinkPath, tried: readonly DialAttempt[]): string | undefined {
  if (path !== 'relay') return pathLabel(path);
  const p2p = tried.find((t) => t.way === 'p2p');
  if (!p2p || p2p.outcome === 'skipped') return 'Your phone went straight to the relay: that’s what worked on its network last time. Still end-to-end encrypted.';
  if (p2p.outcome === 'unreachable' || p2p.outcome === 'refused') return 'Your phone found this Mac but couldn’t connect directly on its network, so it used the relay. Still end-to-end encrypted.';
  return 'Your phone couldn’t reach this Mac directly, so it used the relay. Still end-to-end encrypted.';
}

const MOBILE = 'Try mobile data, or a network that lets devices talk to each other (many dorm, hotel and office Wi-Fi networks don’t).';

export function diagnose(input: DiagnoseInput): Diagnosis {
  const detail = [...(input.report?.tried ?? []).map(attemptLine)];
  if (input.report?.dht === 'unreachable') detail.push('The peer-to-peer network (DHT) didn’t answer this phone.');
  if (input.report?.recordAge !== undefined) detail.push(`Your Mac last said where its relay is ${Math.round(input.report.recordAge / 60_000)} min ago.`);
  if (input.online !== undefined) detail.push(input.online ? 'This phone is online.' : 'This phone couldn’t reach the internet.');
  const make = (d: Omit<Diagnosis, 'detail'>): Diagnosis => ({ ...d, detail });
  const reason = input.reason ?? '';

  if (input.refusal === 'version-mac' || (input.closeCode === 4002 && /Mac/.test(reason)) || /^Update Beluga on your Mac/.test(reason))
    return make({ problem: 'update-mac', title: 'Update Beluga on your Mac', body: 'This app is newer than Beluga on your Mac, so they can’t talk yet.', tryThis: 'Update Beluga on your Mac, then try again.', retry: true, action: 'update-mac' });
  if (input.refusal === 'version-app' || input.closeCode === 4002 || /^Update the Beluga app/.test(reason))
    return make({ problem: 'update-app', title: 'Update the Beluga app', body: 'Beluga on your Mac is newer than this app.', tryThis: 'Update the app from the Play Store.', retry: false, action: 'update-app' });
  if (input.closeCode === 4010) return make({ problem: 'removed', title: 'This phone was removed', body: 'Your Mac doesn’t know this phone any more (it was removed there, or signed out).', tryThis: 'Pair it again from your Mac’s Settings › Phone.', retry: false, action: 'pair-again' });

  switch (input.refusal) {
    case 'expired':
    case 'used':
    case 'cancelled':
      return make({ problem: 'pairing-gone', title: 'That pairing is closed', body: input.refusal === 'used' ? 'Each pairing works for one phone, and that one was used.' : 'Pairings work for 10 minutes, and this one was closed or ran out.', tryThis: 'On your Mac, open Settings › Phone › Pair a Phone… and scan the new code.', retry: false, action: 'pair-again' });
    case 'unverified':
    case 'tries':
      return make({ problem: 'pairing-wrong', title: 'That code didn’t work', body: input.refusal === 'tries' ? 'There were too many tries with it.' : 'The code or link didn’t match the pairing on your Mac.', tryThis: 'Check the code, or start a new pairing on your Mac.', retry: false, action: 'pair-again' });
    case 'busy':
      return make({ problem: 'pairing-busy', title: 'Another phone is pairing', body: 'Your Mac is pairing another phone right now.', tryThis: 'Wait a moment, then try again.', retry: true });
    case 'full':
      return make({ problem: 'pairing-full', title: 'Your Mac has 4 phones', body: 'That’s as many as it pairs.', tryThis: 'Remove one in your Mac’s Settings › Phone, then try again.', retry: true });
    default:
      break;
  }

  if (input.online === false) return make({ problem: 'offline', title: 'This phone is offline', body: 'It can’t reach the internet right now, so it can’t reach your Mac either.', tryThis: 'Turn on Wi-Fi or mobile data, then try again.', retry: true, action: 'open-settings' });

  const r = input.report;
  if (r?.removed) return make({ problem: 'removed', title: 'Your Mac doesn’t know this phone any more', body: 'It was removed on the Mac (Settings › Phone › Remove), or signed out.', tryThis: 'On your Mac, open Settings › Phone › Pair a Phone…, then pair again here.', retry: false, action: 'pair-again' });
  if (r) {
    const relayTried = r.tried.some((t) => t.way === 'relay' && t.outcome !== 'skipped');
    // A pairing key nobody listens on: the pairing is closed (or the code is wrong).
    if (input.stage === 'pair' && r.found === 'no')
      return make({ problem: 'pairing-gone', title: 'Your Mac isn’t offering that pairing', body: 'Pairings work for 10 minutes and for one phone. This one may have run out, been used, or the code may be off.', tryThis: 'On your Mac, open Settings › Phone › Pair a Phone… and scan the new code.', retry: true, action: 'pair-again' });
    const p2pFailed = r.tried.some((t) => t.way === 'p2p' && (t.outcome === 'unreachable' || t.outcome === 'refused' || t.outcome === 'timeout'));
    const relayDown = r.tried.some((t) => t.way === 'relay' && (t.outcome === 'unreachable' || t.outcome === 'not-found' || (t.outcome === 'skipped' && t.code === 'NO_RELAY')));
    if (r.found === 'yes' && p2pFailed && relayDown)
      return make({
        problem: 'relay-down',
        title: 'Reconnecting to your Mac…',
        body: 'Your Mac is online, but this network won’t let them connect directly, and the Mac’s relay isn’t answering yet. Beluga on your Mac restarts it by itself, and this phone keeps trying.',
        tryThis: 'Nothing to do. If it takes more than a few minutes, use mobile data, or check Beluga on your Mac is up to date.',
        retry: true,
        auto: true,
      });
    if (r.found === 'yes')
      return make({ problem: 'no-path', title: 'Your Mac is there, but this network won’t connect you', body: `This network doesn’t let your phone and your Mac connect directly${relayTried ? ', and the relay didn’t get through either' : ''}.`, tryThis: MOBILE, retry: true });
    if (r.dht === 'unreachable')
      return make({ problem: 'dht-blocked', title: 'This network blocks Beluga’s connection', body: `It doesn’t let your phone reach the peer-to-peer network Beluga uses${relayTried ? ', and the relay didn’t answer either' : ''}.`, tryThis: MOBILE, retry: true });
    if (r.found === 'no' || (r.recordAge !== undefined && r.recordAge > 30 * 60_000))
      return make({ problem: 'mac-offline', title: 'Your Mac isn’t online', body: 'It may be asleep, Beluga may be closed, or its network is off. This phone connects by itself as soon as it’s back.', tryThis: 'Wake your Mac and open Beluga. To keep it from sleeping, turn on Keep this Mac awake in Settings.', retry: true, auto: true });
  }
  return make({ problem: 'unknown', title: 'Your Mac didn’t answer', body: 'It may be asleep or offline, or this network may not let you connect.', tryThis: 'Make sure Beluga is open on your Mac. If it is, try mobile data.', retry: true, auto: true });
}
