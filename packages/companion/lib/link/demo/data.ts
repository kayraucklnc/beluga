import type { ChatMessageView, ConvView, NeedsYou, OutputView, PeopleView, PlanView, TurnView, UsageView } from '../protocol';
import { DEMO_IMAGES, type DemoImage } from './images.generated';

/**
 * The demo Mac's world: two projects, a conversation at work with sub-agents taking screenshots
 * and running tests, a plan being run, something of every kind waiting for you, friends and their
 * chats. Everything is shaped exactly as src/companion/views.ts sends it (protocol.ts), so the
 * screens can't tell it from a real Mac.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

/** A file the demo Mac can hand out. */
export interface DemoFile {
  readonly view: OutputView;
  readonly mime: string;
  /** Pictures: base64 JPEG. Text: the text (it may grow: logs). */
  image?: DemoImage;
  /** A picture sent from the phone (base64). */
  b64?: string;
  text?: string;
}

export interface DemoWorld {
  readonly t0: number;
  usage: UsageView[];
  needs: NeedsYou[];
  convs: Map<string, ConvView>;
  projects: { id: string; name: string; convs: string[] }[];
  files: Map<string, DemoFile>;
  plans: PlanView[];
  chats: Map<string, { name: string; kind: 'dm' | 'group'; messages: ChatMessageView[]; unread: number; peer?: string }>;
  people: PeopleView['people'];
}

let seq = 0;
export const ref = (slug: string): string => `out:${slug.replace(/[^\w-]/g, '-').slice(0, 40)}-${(++seq).toString(36).padStart(4, '0')}`;

const E2E_HEAD = [
  '> beluga@0.6.2 test:e2e',
  '> playwright test --project=phone',
  '',
  'Running 215 tests using 4 workers',
  '',
];
export function e2eLine(n: number): string {
  const suites = ['pairing', 'home', 'needs-you', 'conversation', 'outputs', 'plans', 'chats', 'people', 'ask'];
  const suite = suites[n % suites.length];
  const ms = 80 + ((n * 137) % 900);
  const ok = n % 53 !== 0;
  return `  ${ok ? '✓' : '✘'}  ${String(n).padStart(3)} [phone] › ${suite}.spec.ts:${(n * 7) % 180 + 12} › ${ok ? 'renders' : 'swipes'} ${suite} ${['on a small screen', 'offline', 'with a long title', 'after a reconnect'][n % 4]} (${ms}ms)`;
}

const UNIT_LOG = ` RUN  v5.0.5 /Users/kayra/beluga

 ✓ tests/companion-protocol.test.ts (24 tests) 41ms
 ✓ tests/companion-views.test.ts (38 tests) 212ms
 ✓ tests/companion-coverage.test.ts (3 tests) 9ms
 ✓ tests/companion-files.test.ts (17 tests) 88ms
 ✓ tests/companion-pairing.test.ts (12 tests) 1302ms
 ✓ tests/boundaries.test.ts (6 tests) 640ms
 ✓ tests/browser-safe.test.ts (4 tests) 118ms

 Test Files  7 passed (7)
      Tests  104 passed (104)
   Start at  10:41:07
   Duration  4.21s (transform 610ms, setup 0ms, collect 1.9s, tests 2.4s)
`;

const CONTRAST_MD = `# Contrast check · phone, dark

Checked every text style on the glass cards against the backdrop at its brightest fold.

| Style | Ratio | WCAG |
|---|---|---|
| Body on glass | 13.9 : 1 | AAA |
| Secondary | 7.2 : 1 | AAA |
| Tertiary (captions) | 4.1 : 1 | AA large |
| Copper on glass | 5.6 : 1 | AA |

## What I changed

- Captions went from #6a6a70 to #75757c (now 4.1 : 1).
- The tab bar's inactive icons use text-2, not text-3.

## Left alone

The hairlines are decoration (1.3 : 1); nothing reads through them.
`;

const TIMINGS_JSON = JSON.stringify(
  { run: 'e2e phone', at: '2026-10-23T10:44:12Z', suites: { pairing: { now: 9.2, last: 12.8 }, views: { now: 6.1, last: 6.4 }, link: { now: 4.8, last: 7.9 }, outputs: { now: 3.3, last: 3.1 }, push: { now: 2.4, last: 2.6 } }, slowest: ['pairing.spec.ts › dials the temporary key', 'link.spec.ts › reconnects after the grace'] },
  null,
  2,
);

const RADAR_NOTES = `Radar flicker: notes

The tiles flicker when you pinch because each zoom level swaps every tile at once.
Now the old level stays drawn until the new one has loaded, then cross-fades (180 ms).

Tested on: Pixel 7 (Chrome), iPhone 15 (Safari), the Mac (Safari 19).
Frame time while zooming: 6.1 ms → 4.4 ms median, no dropped frames over 30 s of pinching.
`;

export function makeWorld(now = Date.now()): DemoWorld {
  seq = 0;
  const files = new Map<string, DemoFile>();
  const img = (name: string, image: DemoImage, by?: string, ago = 0): OutputView => {
    const view: OutputView = { ref: ref(name), name, kind: 'image', size: Math.round((DEMO_IMAGES[image].b64.length * 3) / 4), ts: now - ago, ...(by ? { by } : {}) };
    files.set(view.ref, { view, mime: 'image/jpeg', image });
    return view;
  };
  const txt = (name: string, kind: OutputView['kind'], text: string, by?: string, ago = 0): OutputView => {
    const view: OutputView = { ref: ref(name), name, kind, size: text.length, ts: now - ago, ...(by ? { by } : {}) };
    files.set(view.ref, { view, mime: kind === 'json' ? 'application/json' : kind === 'markdown' ? 'text/markdown' : 'text/plain', text });
    return view;
  };

  // ---- the conversation at work: polishing the phone's onboarding
  const shotPair = img('pair-screen.png', 'pairScreen', 'a-shots', 6 * MIN);
  const shotConfirm = img('pair-confirm.png', 'confirmScreen', 'a-shots', 5 * MIN);
  const contrastPng = img('contrast.png', 'contrast', 'a-contrast', 9 * MIN);
  const contrastMd = txt('contrast-report.md', 'markdown', CONTRAST_MD, 'a-contrast', 9 * MIN);
  const e2eText = [...E2E_HEAD, ...Array.from({ length: 137 }, (_, i) => e2eLine(i + 1))].join('\n') + '\n';
  const e2eLog = txt('e2e-phone.log', 'text', e2eText, 'a-e2e', 0);
  const unitLog = txt('unit-tests.txt', 'text', UNIT_LOG, undefined, 14 * MIN);
  const timings = txt('timings.json', 'json', TIMINGS_JSON, 'a-e2e', 2 * MIN);
  const timingsPng = img('slowest-suites.png', 'timings', undefined, 2 * MIN);

  const onboarding: ConvView = {
    topic: 'conv:beluga.onboarding',
    title: 'Make pairing feel like the Mac',
    project: 'beluga',
    more: true,
    canSend: true,
    working: true,
    needsYou: [],
    turns: [
      {
        id: 't1',
        who: 'you',
        name: 'You',
        ts: now - 31 * MIN,
        prose: { text: 'The phone\'s pairing screen should feel like the Mac\'s onboarding: the mark, the glow, the springs. Take screenshots of each step when you\'re done, and run the phone e2e suite.', code: [] },
      },
      {
        id: 't2',
        who: 'claude',
        name: 'Claude',
        ts: now - 30 * MIN,
        endTs: now - 15 * MIN,
        status: 'done',
        steps: 23,
        prose: {
          text: 'Done with the first pass. The pairing screen now rises out of the dark like the Mac\'s welcome: the tile comes up, the beluga leaps in, and the glow settles.\n\n**What changed**\n- The backdrop is the same silk shader, ported to Skia\n- Every press springs (320 / 32), and commits tick a haptic\n- The fingerprint step shows four emoji, big, with the Mac\'s name\n\nThe spring settings live in one place:\n\n[[code:0]]\n\nAnd the scanner now accepts both `beluga://` and `klaud://` links:\n\n[[code:1]]\n\nI ran the unit tests too: 104 passed.',
          code: [{ lang: 'ts', lines: 24 }, { lang: 'ts', lines: 9 }],
        },
        outputs: [unitLog],
      },
      {
        id: 't3',
        who: 'you',
        name: 'You',
        ts: now - 12 * MIN,
        prose: { text: 'Lovely. Check the contrast on the glass cards, then the screenshots and the e2e run please.', code: [] },
      },
      {
        id: 't4',
        who: 'claude',
        name: 'Claude',
        ts: now - 11 * MIN,
        status: 'working',
        step: 'Running the phone tests · 137/215',
        steps: 31,
        prose: { text: 'On it. I\'ve split it three ways so it goes faster: one agent checks the contrast, one takes the screenshots, one runs the e2e suite.', code: [] },
        subagents: [
          { id: 'a-contrast', title: 'Check the contrast on glass', status: 'done', steps: ['Read the theme tokens', 'Rendered every text style on the brightest fold', 'Measured 14 pairs', 'Raised the captions to #75757c', 'Wrote contrast-report.md'], outputs: [contrastPng, contrastMd] },
          { id: 'a-shots', title: 'Screenshot each pairing step', status: 'done', steps: ['Started the app in the emulator', 'Opened Pair', 'Took pair-screen.png', 'Scanned the test code', 'Took pair-confirm.png'], outputs: [shotPair, shotConfirm] },
          { id: 'a-e2e', title: 'Run the phone e2e suite', status: 'running', steps: ['Built the web bundle', 'Started 4 workers', 'Running 215 tests · 137 done'], outputs: [e2eLog, timings] },
        ],
        outputs: [timingsPng],
      },
    ],
  };

  const push: ConvView = {
    topic: 'conv:beluga.push',
    title: 'Beluga Push relay',
    project: 'beluga',
    more: false,
    canSend: true,
    working: false,
    needsYou: [],
    turns: [
      { id: 'p1', who: 'you', name: 'You', ts: now - 48 * MIN, prose: { text: 'Write the push relay as a Cloudflare Worker and deploy it to staging.', code: [] } },
      {
        id: 'p2',
        who: 'claude',
        name: 'Claude',
        ts: now - 47 * MIN,
        status: 'working',
        step: 'Waiting for you: deploy to staging?',
        steps: 12,
        prose: { text: 'The Worker is written and its tests pass. It only ever sees a token and ciphertext:\n\n[[code:0]]\n\nI\'d like to deploy it to staging now.', code: [{ lang: 'ts', lines: 58 }] },
      },
    ],
  };

  const radar: ConvView = {
    topic: 'conv:weather.radar',
    title: 'Radar tiles flicker on zoom',
    project: 'pixel-weather',
    more: false,
    canSend: true,
    working: false,
    needsYou: [],
    turns: [
      { id: 'r1', who: 'you', name: 'You', ts: now - 3 * HOUR, prose: { text: 'The radar flickers when I pinch. Fix it and show me.', code: [] } },
      {
        id: 'r2',
        who: 'claude',
        name: 'Claude',
        ts: now - 3 * HOUR + 2 * MIN,
        endTs: now - 2.6 * HOUR,
        status: 'done',
        steps: 17,
        prose: { text: 'Fixed: the old zoom level now stays drawn until the new tiles have loaded, then they cross-fade. Here it is mid-pinch, and my notes.\n\n[[code:0]]', code: [{ lang: 'ts', lines: 31 }] },
        outputs: [img('radar-zoom.png', 'radar', undefined, 2.6 * HOUR), txt('radar-notes.txt', 'text', RADAR_NOTES, undefined, 2.6 * HOUR)],
      },
    ],
  };

  const flaky: ConvView = {
    topic: 'conv:weather.ci',
    title: 'CI is red on main',
    project: 'pixel-weather',
    more: false,
    canSend: true,
    working: false,
    needsYou: [],
    turns: [
      { id: 'c1', who: 'you', name: 'You', ts: now - 26 * HOUR, prose: { text: 'Why is CI red?', code: [] } },
      { id: 'c2', who: 'claude', name: 'Claude', ts: now - 26 * HOUR, endTs: now - 25.8 * HOUR, status: 'failed', steps: 6, prose: { text: 'The forecast API\'s sandbox is down (503 since 09:12), so the contract tests fail. Nothing in the code changed. I stopped there.', code: [] } },
    ],
  };

  const convs = new Map<string, ConvView>([onboarding, push, radar, flaky].map((c) => [c.topic, c]));

  // ---- what needs you, one of each kind (and one this phone doesn't know)
  // Shaped exactly as src/companion/views.ts makes them (the same methods, args and templates).
  const EMPTY_Q = 'What should Home show when nothing is running?';
  const CHECKS_Q = 'Which checks should run before the phone build ships?';
  const PLAN_Q = 'Ship notifications before iOS?';
  const needs: NeedsYou[] = [
    {
      id: 'n-deploy',
      kind: 'approval',
      title: 'Deploy the push relay to staging?',
      detail: 'Claude wants to run: wrangler deploy --env staging\n\nIn beluga · Beluga Push relay',
      from: 'Your Claude',
      topic: 'conv:beluga.push',
      askedAt: now - 4 * MIN,
      actions: [
        { label: 'Approve', tone: 'main', method: 'host.answerApproval', args: ['yes', 'ap-deploy'] },
        { label: 'Decline', tone: 'danger', method: 'host.answerApproval', args: ['no', 'ap-deploy'] },
        { label: 'Always', tone: 'plain', method: 'host.answerApproval', args: ['always', 'ap-deploy'] },
      ],
    },
    {
      // A single question with a few options: a button each, Skip, and the template for your own words.
      id: 'n-empty',
      kind: 'question',
      title: EMPTY_Q,
      detail: "Claude is drawing the empty state of the phone's Home.",
      from: 'Your Claude',
      topic: 'conv:beluga.onboarding',
      askedAt: now - 7 * MIN,
      choices: [
        { label: 'The Mac, breathing', description: 'Just the mark and your allowance.' },
        { label: 'Recent outputs', description: 'The last pictures and files, big.' },
        { label: 'A prompt to ask', description: '"Ask your Mac…" front and center.' },
      ],
      multi: false,
      freeText: true,
      actions: [
        ...['The Mac, breathing', 'Recent outputs', 'A prompt to ask'].map((label) => ({ label, tone: 'plain' as const, method: 'questions.answer', args: ['q-empty', { kind: 'answers', answers: { [EMPTY_Q]: label } }] })),
        { label: 'Skip', tone: 'danger', method: 'questions.answer', args: ['q-empty', { kind: 'skip' }] },
      ],
      answer: { method: 'questions.answer', args: ['q-empty', { kind: 'answers', answers: { [EMPTY_Q]: '' } }], slot: [1, 'answers', EMPTY_Q], join: ', ', text: true, picks: true, label: 'Send' },
    },
    {
      // Several picks: no per-option buttons; the phone sends them joined through the template.
      id: 'n-checks',
      kind: 'question',
      title: CHECKS_Q,
      from: 'Your Claude',
      topic: 'conv:beluga.onboarding',
      askedAt: now - 9 * MIN,
      choices: [{ label: 'Unit tests' }, { label: 'Phone e2e' }, { label: 'Contrast check' }, { label: 'APK size' }],
      multi: true,
      freeText: true,
      actions: [{ label: 'Skip', tone: 'danger', method: 'questions.answer', args: ['q-checks', { kind: 'skip' }] }],
      answer: { method: 'questions.answer', args: ['q-checks', { kind: 'answers', answers: { [CHECKS_Q]: '' } }], slot: [1, 'answers', CHECKS_Q], join: ', ', text: true, picks: true, label: 'Send' },
    },
    {
      id: 'n-mia',
      kind: 'request',
      title: "Mia's Claude would like a screenshot of your desktop",
      detail: '"Mia asked me to check how the radar looks on your big screen."',
      from: "Mia's Claude",
      askedAt: now - 12 * MIN,
      actions: [
        { label: 'Approve', tone: 'main', method: 'gateway.decide', args: ['gw-mia', { answer: 'yes' }] },
        { label: 'Decline', tone: 'danger', method: 'gateway.decide', args: ['gw-mia', { answer: 'no' }] },
        { label: 'Always', tone: 'plain', method: 'gateway.decide', args: ['gw-mia', { answer: 'always' }] },
      ],
    },
    {
      // A plan's decision is one of Claude's questions with a `decide:` id.
      id: 'n-plan',
      kind: 'decision',
      title: PLAN_Q,
      detail: 'Milestone 4 can start now, or wait for the iOS port so both platforms get push together.',
      from: 'the plan “Beluga for phones”',
      topic: 'plan:phones',
      askedAt: now - 22 * MIN,
      choices: [{ label: 'Notifications first' }, { label: 'Wait for iOS' }],
      multi: false,
      freeText: true,
      actions: [
        ...['Notifications first', 'Wait for iOS'].map((label) => ({ label, tone: 'plain' as const, method: 'questions.answer', args: ['decide:phones:m4', { kind: 'answers', answers: { [PLAN_Q]: label } }] })),
        { label: 'Skip', tone: 'danger', method: 'questions.answer', args: ['decide:phones:m4', { kind: 'skip' }] },
      ],
      answer: { method: 'questions.answer', args: ['decide:phones:m4', { kind: 'answers', answers: { [PLAN_Q]: '' } }], slot: [1, 'answers', PLAN_Q], join: ', ', text: true, picks: true, label: 'Send' },
    },
    {
      // A milestone done and checked: pass it, check again, or send it back with what to change.
      id: 'n-review',
      kind: 'decision',
      title: 'The contract is done. Pass it?',
      detail: 'All criteria met: protocol.ts, coverage.ts.',
      from: 'the plan “Beluga for phones”',
      topic: 'plan:phones',
      askedAt: now - 30 * MIN,
      actions: [
        { label: 'Pass', tone: 'main', method: 'plans.pass', args: ['phones', 'm1'] },
        { label: 'Check again', tone: 'plain', method: 'plans.recheck', args: ['phones', 'm1'] },
      ],
      answer: { method: 'plans.sendBack', args: ['phones', 'm1', ''], slot: [2], text: true, picks: false, label: 'Send back' },
    },
    {
      id: 'n-theo',
      kind: 'request',
      title: 'Theo is knocking on your room',
      detail: 'He used your invite link from the group chat.',
      from: 'Theo',
      askedAt: now - 35 * MIN,
      actions: [
        { label: 'Let in', tone: 'main', method: 'invites.letIn', args: ['theo'] },
        { label: 'Turn away', tone: 'danger', method: 'invites.decline', args: ['theo'] },
      ],
    },
    {
      id: 'n-join',
      kind: 'request',
      title: 'Ada asks to join beluga-dev',
      from: 'Ada',
      askedAt: now - 42 * MIN,
      actions: [
        { label: 'Let in', tone: 'main', method: 'network.groups.approve', args: ['beluga-dev', 'ada'] },
        { label: 'Decline', tone: 'danger', method: 'network.groups.decline', args: ['beluga-dev', 'ada'] },
      ],
    },
    {
      id: 'n-handoff',
      kind: 'handoff',
      title: 'Sam wants to hand you "Offline maps"',
      detail: 'A worktree with 14 changes, waiting on your Mac.',
      from: 'Sam',
      askedAt: now - 50 * MIN,
      actions: [],
    },
  ];

  // ---- a plan being run
  const plan: PlanView = {
    id: 'phones',
    title: 'Beluga for phones',
    goal: 'A companion app for one person: what the Mac is doing, what needs you, and asking it anything, from the phone.',
    state: 'running',
    topic: 'conv:beluga.onboarding',
    needsYou: [],
    milestones: [
      { id: 'm1', title: 'The contract', state: 'done', criteria: ['protocol.ts with frames, topics and views', 'coverage.ts classifies every API method'], tasks: [
        { id: 'k1', title: 'Frames and topics', state: 'done' },
        { id: 'k2', title: 'Views for every screen', state: 'done' },
        { id: 'k3', title: 'Coverage of the API', state: 'done' },
      ] },
      { id: 'm2', title: 'The Mac side', state: 'running', criteria: ['Pair a phone from Settings', 'Only paired link keys get through'], tasks: [
        { id: 'k4', title: 'Pairing and the device certificate', state: 'done' },
        { id: 'k5', title: 'CompanionHost and the firewall', state: 'running', topic: 'conv:beluga.push' },
        { id: 'k6', title: 'The footer\'s phone mark', state: 'todo' },
      ] },
      { id: 'm3', title: 'The app', state: 'running', criteria: ['Every screen against a demo Mac', 'Pairing feels like the Mac\'s onboarding'], tasks: [
        { id: 'k7', title: 'Home, Work and a conversation', state: 'done' },
        { id: 'k8', title: 'Make pairing feel like the Mac', state: 'running', mine: true, topic: 'conv:beluga.onboarding' },
        { id: 'k9', title: 'Outputs viewer', state: 'review' },
        { id: 'k10', title: 'The link worklet', state: 'todo' },
      ] },
      { id: 'm4', title: 'Notifications', state: 'waiting', criteria: ['Beluga Push relay', 'Approve from the notification'], tasks: [
        { id: 'k11', title: 'The Worker', state: 'blocked' },
        { id: 'k12', title: 'Notification actions', state: 'todo' },
      ] },
      { id: 'm5', title: 'iOS', state: 'todo', criteria: ['Keychain, APNs, the service extension'], tasks: [{ id: 'k13', title: 'Port the link to iOS', state: 'todo' }] },
    ],
  };
  const docsPlan: PlanView = {
    id: 'docs',
    title: 'Docs for the network',
    state: 'done',
    milestones: [{ id: 'd1', title: 'Write it up', state: 'done', criteria: [], tasks: [{ id: 'd1a', title: 'How it works', state: 'done' }, { id: 'd1b', title: 'Pictures', state: 'done' }] }],
    needsYou: [],
  };
  const radarPlan: PlanView = {
    id: 'weather-v2',
    title: 'Pixel Weather v2',
    goal: 'Smooth radar, offline maps, a widget.',
    state: 'draft',
    milestones: [
      { id: 'w1', title: 'Smooth radar', state: 'todo', criteria: ['No flicker on zoom'], tasks: [{ id: 'w1a', title: 'Cross-fade tiles', state: 'todo' }] },
      { id: 'w2', title: 'Offline maps', state: 'todo', criteria: [], tasks: [{ id: 'w2a', title: 'Tile cache', state: 'todo' }, { id: 'w2b', title: 'Download a region', state: 'todo' }] },
    ],
    needsYou: [],
  };

  // ---- friends and chats
  const sunset = img('IMG_2041.jpg', 'sunset', undefined, 40 * MIN);
  const desktop = img('mia-desktop.png', 'desktop', undefined, 2 * HOUR);
  const chats: DemoWorld['chats'] = new Map([
    [
      'chat:dm:mia',
      {
        name: 'Mia',
        kind: 'dm' as const,
        peer: 'mia',
        unread: 2,
        messages: [
          { id: 'm1', from: 'Mia', mine: false, text: 'is the phone app real?? 👀', ts: now - 3 * HOUR },
          { id: 'm2', from: 'You', mine: true, text: 'getting there. I\'m approving deploys from the couch', ts: now - 3 * HOUR + 2 * MIN },
          { id: 'm3', from: 'Mia\'s Claude', mine: false, claude: true, text: 'Here\'s Mia\'s desktop, as you asked: the radar build is open on the left.', ts: now - 2 * HOUR, files: [desktop] },
          { id: 'm4', from: 'Mia', mine: false, text: 'view from the office today', ts: now - 41 * MIN, files: [sunset] },
          { id: 'm5', from: 'Mia', mine: false, text: 'also my Claude wants a look at your screen for the radar thing, ok?', ts: now - 12 * MIN },
        ],
      },
    ],
    [
      'chat:dm:theo',
      {
        name: 'Theo',
        kind: 'dm' as const,
        peer: 'theo',
        unread: 0,
        messages: [
          { id: 't1', from: 'Theo', mine: false, text: 'sent you a join request for the room', ts: now - 36 * MIN },
          { id: 't2', from: 'You', mine: true, text: '👍 will let you in in a sec', ts: now - 30 * MIN },
        ],
      },
    ],
    [
      'chat:group:beluga-dev',
      {
        name: 'beluga-dev',
        kind: 'group' as const,
        unread: 5,
        messages: [
          { id: 'g1', from: 'Sam', mine: false, text: 'offline maps branch is ready for someone to take over', ts: now - 55 * MIN },
          { id: 'g2', from: 'Ada', mine: false, text: 'push relay: are we doing FCM data messages only?', ts: now - 25 * MIN },
          { id: 'g3', from: 'You', mine: true, text: 'yes, sealed to the phone\'s box key, the relay only sees ciphertext', ts: now - 24 * MIN },
          { id: 'g4', from: 'Ada', mine: false, text: 'nice. the e2e numbers from my run:', ts: now - 9 * MIN, files: [txt('ada-e2e.txt', 'text', 'pairing 9.4s\nviews 6.0s\nlink 5.1s\n', undefined, 9 * MIN)] },
          { id: 'g5', from: 'Theo', mine: false, text: 'can someone let me into the room 🙏', ts: now - 3 * MIN },
        ],
      },
    ],
  ]);

  const people: PeopleView['people'] = [
    { peerId: 'mia', name: 'Mia', presence: 'online', note: 'radar all day', offers: ['screen', 'commands', 'files'], chat: 'chat:dm:mia', usage: { provider: 'Claude Code', plan: 'Max', windows: [{ label: '5 hours', pct: 41, resetsAt: now + 2.2 * HOUR }, { label: 'Week', pct: 77, resetsAt: now + 2.5 * 24 * HOUR }], updatedAt: now - 5 * MIN } },
    { peerId: 'theo', name: 'Theo', presence: 'away', note: 'in a meeting', offers: ['files'], chat: 'chat:dm:theo', usage: { provider: 'Claude Code', plan: 'Pro', windows: [{ label: '5 hours', pct: 8 }, { label: 'Week', pct: 34 }], updatedAt: now - 30 * MIN } },
    { peerId: 'ada', name: 'Ada', presence: 'dnd', offers: ['screen', 'commands'], usage: { provider: 'Claude Code', plan: 'Max', windows: [{ label: '5 hours', pct: 88 }, { label: 'Week', pct: 51 }], updatedAt: now - 9 * MIN } },
    { peerId: 'sam', name: 'Sam', presence: 'offline', note: 'back Monday', offers: [] },
  ];

  const usage: UsageView[] = [
    {
      provider: 'Claude Code',
      plan: 'Max',
      windows: [
        { label: '5 hours', pct: 18, resetsAt: now + 3.4 * HOUR },
        { label: 'Week', pct: 62, resetsAt: now + 3 * 24 * HOUR + 5 * HOUR },
      ],
      updatedAt: now - MIN,
    },
  ];

  return {
    t0: now,
    usage,
    needs,
    convs,
    projects: [
      { id: 'beluga', name: 'beluga', convs: ['conv:beluga.onboarding', 'conv:beluga.push'] },
      { id: 'pixel-weather', name: 'pixel-weather', convs: ['conv:weather.radar', 'conv:weather.ci'] },
      { id: 'asked', name: 'Asked of friends', convs: [] },
    ],
    files,
    plans: [plan, radarPlan, docsPlan],
    chats,
    people,
  };
}

/** A new turn helper for the live parts. */
export const turn = (t: Partial<TurnView> & Pick<TurnView, 'id' | 'who' | 'name'>, text: string, now = Date.now()): TurnView => ({ ts: now, prose: { text, code: [] }, ...t });
