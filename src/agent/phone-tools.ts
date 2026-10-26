import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { PhoneTools } from './types.js';

/**
 * Your phone, from your Mac (BLG-150, core/phone): the tools of the owner's own runs for acting on
 * their own paired Android phone (server `beluga_phone`). Each tool calls the controller
 * (src/companion/phone-control.ts), which uses the best route it has — Wireless debugging over
 * adb, or the app's Accessibility service — so the tools stay about *what* to do, not *how*.
 *
 * Only the owner's runs get these (never a friend's, never a guest). `status`, `screenshot` and
 * `screen` are always allowed; the acting tools follow the phone's setting (Off · Ask · Use · Full),
 * which the owner approves through Beluga.
 */

export const PHONE_TOOL_NAMES = [
  'phone_status', 'phone_screenshot', 'phone_screen', 'phone_tap', 'phone_swipe', 'phone_type', 'phone_key', 'phone_scroll', 'phone_open', 'phone_apps', 'phone_info', 'phone_install', 'phone_shell', 'phone_logcat', 'phone_push', 'phone_pull', 'phone_notifications', 'phone_macro_save', 'phone_macro_list', 'phone_macro_run', 'phone_macro_delete',
].map((n) => `mcp__beluga_phone__${n}`);
/** The tools that only look (never change the phone): always allowed, like the Mac's screenshot. */
export const PHONE_LOOK_TOOLS = ['phone_status', 'phone_screenshot', 'phone_screen', 'phone_apps', 'phone_info', 'phone_pull', 'phone_notifications', 'phone_macro_list'].map((n) => `mcp__beluga_phone__${n}`);

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

async function guarded(fn: () => Promise<Content[]> | Content[]): Promise<{ content: Content[]; isError?: boolean }> {
  try {
    return { content: await fn() };
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}
const words = (text: string): Content[] => [{ type: 'text', text }];

export function createPhoneToolDefs(phone: PhoneTools) {
  return [
    tool('phone_status', 'Your phone now: which phone, how it’s reached (Wireless debugging or the Accessibility service), and what you can do. Check it first; it says if a phone isn’t usable and why.', {}, () =>
      guarded(async () => words((await phone.status()) ?? 'No phone is set up for Claude right now.')),
    ),
    tool(
      'phone_screenshot',
      'A screenshot of the phone’s screen. It’s saved as an output (so the owner sees it on their phone and Mac) and returned for you to look at. Take one before acting, and again after, to see what happened.',
      {},
      () =>
        guarded(async () => {
          const shot = await phone.screenshot();
          return [{ type: 'text', text: shot.text }, ...(shot.image ? [{ type: 'image' as const, data: shot.image.data, mimeType: shot.image.mimeType }] : [])];
        }),
    ),
    tool(
      'phone_screen',
      'The phone’s screen as a list of elements, each with a number (#3), what it says, whether it’s tappable or a text field, and its centre as x,y. Use a node number with phone_tap/phone_type when there is one; it’s steadier than pixels.',
      {},
      () => guarded(async () => words(await phone.screen())),
    ),
    tool(
      'phone_tap',
      'Tap the screen: give a node number from phone_screen (best), or x,y pixels.',
      { x: z.number().int().min(0).describe('x pixel'), y: z.number().int().min(0).describe('y pixel'), node: z.number().int().min(0).optional().describe('A #number from phone_screen; when set, x,y are ignored') },
      (a) => guarded(async () => words(await phone.tap(a))),
    ),
    tool(
      'phone_swipe',
      'Swipe or drag from one point to another (pixels), over `ms` milliseconds. For scrolling a list, phone_scroll is easier.',
      { x1: z.number().int().min(0), y1: z.number().int().min(0), x2: z.number().int().min(0), y2: z.number().int().min(0), ms: z.number().int().min(50).max(5000).optional() },
      (a) => guarded(async () => words(await phone.swipe(a))),
    ),
    tool(
      'phone_type',
      'Type text into the focused field (or a node from phone_screen). `replace` clears it first; `enter` presses the keyboard’s action after.',
      { text: z.string().max(8000), replace: z.boolean().optional(), enter: z.boolean().optional(), node: z.number().int().min(0).optional() },
      (a) => guarded(async () => words(await phone.type(a))),
    ),
    tool(
      'phone_key',
      'Press a phone button: back, home, recents, notifications, enter, or lock.',
      { key: z.enum(['back', 'home', 'recents', 'notifications', 'enter', 'lock']) },
      (a) => guarded(async () => words(await phone.key(a.key))),
    ),
    tool('phone_scroll', 'Scroll the screen a page in a direction.', { dir: z.enum(['up', 'down', 'left', 'right']), node: z.number().int().min(0).optional() }, (a) => guarded(async () => words(await phone.scroll(a)))),
    tool(
      'phone_open',
      'Open an app by its package name (e.g. com.android.settings), or a link (https:, tel:, a deep link) in whatever app handles it.',
      { package: z.string().max(200).optional(), url: z.string().max(4000).optional() },
      (a) => guarded(async () => words(await phone.open(a))),
    ),
    tool('phone_apps', 'The apps installed on the phone (package name and label).', {}, () => guarded(async () => words(await phone.apps()))),
    tool('phone_info', 'The phone in a few facts: model, Android version, screen size, battery, network.', {}, () => guarded(async () => words(await phone.info()))),
    tool(
      'phone_install',
      'Install an APK on the phone (a path to a .apk on this Mac, e.g. one you just built). The phone shows its own Install button to confirm. Needs Wireless debugging.',
      { path: z.string().min(1).max(4096).describe('Absolute path to the .apk on this Mac') },
      (a) => guarded(async () => words(await phone.install(a.path))),
    ),
    tool(
      'phone_shell',
      'Run a command in the phone’s shell (adb shell) and return its output. Needs Wireless debugging. For taps and typing, prefer the tools above.',
      { command: z.string().min(1).max(4000) },
      (a) => guarded(async () => words(await phone.shell(a.command))),
    ),
    tool('phone_logcat', 'Recent lines from the phone’s log (logcat). Needs Wireless debugging. `filter` is an optional logcat filter like "ReactNative:V *:S".', { filter: z.string().max(200).optional() }, (a) =>
      guarded(async () => words(await phone.logcat(a.filter))),
    ),
    tool(
      'phone_push',
      'Send a file from this Mac to the phone (needs Wireless debugging). Lands in Downloads unless you give `dest`.',
      { path: z.string().min(1).max(4096).describe('Absolute path on this Mac'), dest: z.string().max(4096).optional().describe('Folder (or path) on the phone, e.g. /sdcard/Download/') },
      (a) => guarded(async () => words(await phone.push(a.path, a.dest))),
    ),
    tool('phone_pull', 'Get a file from the phone to this Mac (needs Wireless debugging); it’s saved as an output.', { path: z.string().min(1).max(4096).describe('Path on the phone, e.g. /sdcard/Download/report.pdf') }, (a) =>
      guarded(async () => words(await phone.pull(a.path))),
    ),
    tool('phone_notifications', 'The phone’s current notifications (needs Wireless debugging): app, title and text.', {}, () => guarded(async () => words(await phone.notifications()))),
    tool(
      'phone_macro_save',
      'Save a flow you just did as a named, repeatable macro (BLG-175). Prefer tapText steps (tap by the text an element shows) over tap x,y — they keep working when the screen shifts. Open the right app first.',
      {
        name: z.string().min(1).max(60),
        steps: z
          .array(
            z.union([
              z.object({ op: z.literal('open'), package: z.string().max(200).optional(), url: z.string().max(4000).optional() }),
              z.object({ op: z.literal('tapText'), text: z.string().min(1).max(200) }),
              z.object({ op: z.literal('tap'), x: z.number().int().min(0), y: z.number().int().min(0) }),
              z.object({ op: z.literal('type'), text: z.string().max(4000), enter: z.boolean().optional(), clear: z.boolean().optional() }),
              z.object({ op: z.literal('key'), key: z.string().max(40) }),
              z.object({ op: z.literal('swipe'), x1: z.number().int(), y1: z.number().int(), x2: z.number().int(), y2: z.number().int(), ms: z.number().int().optional() }),
              z.object({ op: z.literal('scroll'), dir: z.enum(['up', 'down', 'left', 'right']) }),
              z.object({ op: z.literal('wait'), ms: z.number().int().min(100).max(20_000) }),
            ]),
          )
          .min(1)
          .max(100)
          .describe('The steps, in order'),
      },
      (a) => guarded(async () => words(await phone.macroSave(a.name, a.steps))),
    ),
    tool('phone_macro_list', 'The saved phone macros.', {}, () => guarded(async () => words(await phone.macroList()))),
    tool('phone_macro_run', 'Run a saved macro on the phone by name.', { name: z.string().min(1).max(60) }, (a) => guarded(async () => words(await phone.macroRun(a.name)))),
    tool('phone_macro_delete', 'Delete a saved macro by name.', { name: z.string().min(1).max(60) }, (a) => guarded(async () => words(await phone.macroDelete(a.name)))),
  ];
}

export function createPhoneTools(phone: PhoneTools) {
  return createSdkMcpServer({ name: 'beluga_phone', version: '0.1.0', tools: createPhoneToolDefs(phone) });
}

/** What Claude is told about the phone it can drive (added to the system prompt for the owner's runs). */
export function phoneBrief(summary: string): string {
  return [
    '',
    '',
    'Your phone (mcp__beluga_phone__*): the owner’s own Android phone is paired with this Mac, and you can drive it.',
    summary,
    '- When asked to do something on the phone ("get me the newest photo", "install X", "what does this app say"), do it',
    '  yourself with these tools, end to end, and bring the result back here: a file you pulled or a screenshot you took goes',
    '  in your answer (an image as a Markdown image with its absolute path). Never ask the owner to tap or look at the mirror',
    '  for something you can do; only hand over what truly needs them (a password, a fingerprint, a confirmation on the phone).',
    '- An app from the Play Store: phone_open the link https://play.google.com/store/apps/details?id=<package>, then tap Install.',
    '- Look before you leap: phone_screenshot to see it, phone_screen for a list of tappable elements with numbers.',
    '- Act: phone_tap (a #node or x,y), phone_type, phone_swipe, phone_scroll, phone_key, phone_open.',
    '- phone_install puts an APK on the phone (the phone confirms). phone_shell and phone_logcat need Wireless debugging.',
    '- After acting, take another screenshot to check what happened before the next step. Work in small, checked steps.',
    '- If a tool says the phone can’t be reached, say so plainly and what would fix it (turn on debugging or Accessibility); don’t keep retrying.',
    '',
    'Running an app on the phone (the dev loop): adb is on your PATH and points at this phone, so in Bash you can',
    'build and install directly — e.g. `./gradlew assembleDebug` then `adb install -r <apk>`, or `adb shell am start -n <pkg>/<activity>`,',
    '`adb logcat -d` for recent logs, `scrcpy` to mirror. Then phone_screenshot to see the result. Prefer phone_install / phone_open',
    'for the simple cases. Call phone_status once first so adb is connected to the phone.',
    '',
    'Turning a screen into data: phone_screen gives the on-screen text and fields; a phone_screenshot is an image you can read',
    'directly — so you can OCR a photo, read a QR code, or lift the numbers off a dashboard. When the result is rows or a trend,',
    'show it with mcp__beluga_view__show (a table or chart) rather than pasting a wall of text. To read a photo, phone_pull it',
    '(e.g. the newest file in /sdcard/DCIM/Camera) and look at it.',
    '',
    'Macros (record & replay): once you’ve done a flow, save it with phone_macro_save so the owner can re-run it — "every morning',
    'open Strava and screenshot my stats". Use tapText steps (tap by the text an element shows) over tap x,y, so it keeps working',
    'when the screen shifts. phone_macro_list / phone_macro_run / phone_macro_delete manage them.',
  ].join('\n');
}
