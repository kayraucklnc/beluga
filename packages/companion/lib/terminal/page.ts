import { XTERM_CSS, XTERM_JS } from './xterm.generated';

/**
 * The terminal's page (BLG-42): xterm.js, bundled (no CDN), drawing the Mac's PTY output in a
 * WebView on the phone (an iframe in the web build). The app and the page talk in small JSON
 * messages:
 *
 * - in (`window.__beluga(msg)`): `data` (the PTY's bytes; `reset` clears first), `size` (the
 *   Mac's grid), `ctrl` (the key bar's Ctrl, for the next key), `paste`, `zoom`, `bottom`,
 *   `focus`, `blur`;
 * - out (ReactNativeWebView.postMessage, or the parent's postMessage): `ready`, `input` (keys typed
 *   here), `ctrlUsed`, `zoom` (what a pinch left).
 *
 * The grid is always the Mac's (cols × rows): the page fits its width to the screen, and a pinch
 * zooms in (then it pans sideways). One finger scrolls back; a tap brings up the keyboard.
 * Answers xterm.js would give to the program's own queries (cursor position, device attributes)
 * are dropped: the Mac's screen answers those, once.
 */

export interface TermTheme {
  readonly background: string;
  readonly foreground: string;
  readonly cursor: string;
  readonly selection: string;
  readonly ansi: readonly string[];
}

/** ANSI colours that read on the Mac's terminal backgrounds (muted, never neon). */
export const TERM_THEMES: Readonly<Record<'light' | 'dark', TermTheme>> = {
  light: {
    background: '#FBFBFC',
    foreground: '#1D1D1F',
    cursor: '#5D5D63',
    selection: 'rgba(47,94,142,0.22)',
    ansi: ['#1D1D1F', '#B23A48', '#2C7A52', '#8A6A12', '#2F5E8E', '#7A4A9C', '#1F7A86', '#8E8E93', '#5D5D63', '#C9485A', '#358F61', '#A07E1C', '#3B72AA', '#8F5DB5', '#27909D', '#B8B8BE'],
  },
  dark: {
    background: '#17171A',
    foreground: '#ECECEE',
    cursor: '#A8A8AE',
    selection: 'rgba(169,200,236,0.28)',
    ansi: ['#1E1E1E', '#E06C75', '#98C379', '#E5C07B', '#61AFEF', '#C678DD', '#56B6C2', '#D0D0D0', '#5C6370', '#FF7A85', '#B5E890', '#FFD88A', '#7EC3FF', '#DE9BF0', '#7FD4DE', '#FFFFFF'],
  },
};

const xtermTheme = (t: TermTheme) => ({
  background: t.background,
  foreground: t.foreground,
  cursor: t.cursor,
  cursorAccent: t.background,
  selectionBackground: t.selection,
  black: t.ansi[0], red: t.ansi[1], green: t.ansi[2], yellow: t.ansi[3], blue: t.ansi[4], magenta: t.ansi[5], cyan: t.ansi[6], white: t.ansi[7],
  brightBlack: t.ansi[8], brightRed: t.ansi[9], brightGreen: t.ansi[10], brightYellow: t.ansi[11], brightBlue: t.ansi[12], brightMagenta: t.ansi[13], brightCyan: t.ansi[14], brightWhite: t.ansi[15],
});

/**
 * What runs in the page, as plain JavaScript text: Hermes keeps no source for functions, so it
 * can't be a function's toString(). Called with the boot options by terminalPage.
 */
const PAGE_JS = String.raw`(function (boot) {
  var w = window;
  var post = function (m) {
    var s = JSON.stringify(m);
    if (w.ReactNativeWebView) w.ReactNativeWebView.postMessage(s);
    else window.parent.postMessage({ __belugaTerm: s }, '*');
  };
  var wrap = document.getElementById('wrap');
  var box = document.getElementById('term');
  var cols = boot.cols;
  var rows = boot.rows;
  // The width of one cell per pixel of font size, measured once in this font.
  var probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-size:100px;font-family:' + boot.font;
  probe.textContent = 'WWWWWWWWWWWWWWWWWWWW';
  document.body.appendChild(probe);
  var perPx = probe.getBoundingClientRect().width / 20 / 100 || 0.6;
  probe.remove();
  // The font size that fits the Mac's columns to the screen; the zoom is on top of it (1 = fitted).
  var fitSize = function () { return Math.max(4, (wrap.clientWidth - 8) / (cols * perPx)); };
  var zoom = boot.zoom;
  var sizeNow = function () { return Math.min(28, Math.max(fitSize(), fitSize() * zoom)); };
  var term = new w.Terminal({ cols: cols, rows: rows, fontFamily: boot.font, fontSize: sizeNow(), lineHeight: 1.12, theme: boot.theme, scrollback: 5000, allowProposedApi: true, cursorBlink: false, macOptionIsMeta: true, drawBoldTextInBrightColors: false });
  term.open(box);
  var ctrl = false;
  // The program's own questions (cursor position, device attributes, colours) are answered by the Mac's screen, not twice.
  var REPLY = /^\x1b\[(\?|>)?[\d;]*[cnRy]$|^\x1b\][\d;]*rgb:[^\x07\x1b]*(\x07|\x1b\\)$|^\x1bP[\s\S]*\x1b\\$/;
  term.onData(function (d) {
    if (REPLY.test(d)) return;
    var data = d;
    if (ctrl && d.length === 1) {
      var c = d.toUpperCase().charCodeAt(0);
      if (c >= 64 && c <= 95) data = String.fromCharCode(c - 64);
      else if (d === ' ') data = '\x00';
      else if (d === '?') data = '\x7f';
      ctrl = false;
      post({ t: 'ctrlUsed' });
    }
    post({ t: 'input', data: data });
  });
  var refit = function () {
    var size = sizeNow();
    if (Math.abs(term.options.fontSize - size) > 0.05) term.options.fontSize = size;
  };
  window.addEventListener('resize', refit);

  // Touch: one finger scrolls back (and sideways when zoomed in), two pinch, a tap brings up the keyboard.
  var start, pinch, carry = 0;
  var dist = function (e) { return Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); };
  wrap.addEventListener('touchstart', function (e) {
    if (e.touches.length === 2) { pinch = { d: dist(e), zoom: zoom }; start = undefined; }
    else if (e.touches.length === 1) start = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(), moved: false };
  }, { passive: true });
  wrap.addEventListener('touchmove', function (e) {
    e.preventDefault();
    if (pinch && e.touches.length === 2) {
      zoom = Math.max(1, Math.min(4, (pinch.zoom * dist(e)) / pinch.d));
      refit();
      return;
    }
    if (!start || e.touches.length !== 1) return;
    var t = e.touches[0];
    var dx = t.clientX - start.x, dy = t.clientY - start.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) start.moved = true;
    wrap.scrollLeft -= dx;
    var line = term.options.fontSize * 1.12;
    carry += dy;
    var n = Math.trunc(carry / line);
    if (n) { term.scrollLines(-n); carry -= n * line; }
    start.x = t.clientX;
    start.y = t.clientY;
  }, { passive: false });
  wrap.addEventListener('touchend', function (e) {
    if (pinch && e.touches.length < 2) { pinch = undefined; post({ t: 'zoom', zoom: zoom }); }
    if (start && !start.moved && Date.now() - start.t < 350) term.focus();
    start = undefined;
  });
  // A mouse wheel (the web build) scrolls back too.
  wrap.addEventListener('wheel', function (e) {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    term.scrollLines(Math.round(e.deltaY / 20) || (e.deltaY > 0 ? 1 : -1));
  }, { passive: false });

  // Messages from the app. Output is written in order, one batch at a time.
  var pending = '', writing = false;
  var flush = function () {
    if (writing || !pending) return;
    var d = pending;
    pending = '';
    writing = true;
    term.write(d, function () { writing = false; flush(); });
  };
  w.__beluga = function (raw) {
    var m = typeof raw === 'string' ? JSON.parse(raw) : raw;
    switch (m.t) {
      case 'data':
        if (m.reset) { pending = ''; term.reset(); }
        pending += String(m.data || '');
        flush();
        return;
      case 'size':
        cols = Math.max(1, Number(m.cols) || cols);
        rows = Math.max(1, Number(m.rows) || rows);
        if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
        refit();
        return;
      case 'ctrl':
        ctrl = Boolean(m.on);
        return;
      case 'key': {
        // A key from the key bar, as the program expects it now (arrows in its cursor mode), with Ctrl when it's on.
        var arrows = { up: 'A', down: 'B', right: 'C', left: 'D' };
        var k = String(m.key || '');
        var app = term.modes && term.modes.applicationCursorKeysMode;
        var data = arrows[k] ? (ctrl ? '\x1b[1;5' : app ? '\x1bO' : '\x1b[') + arrows[k] : k === 'esc' ? '\x1b' : k === 'tab' ? '\t' : k;
        if (ctrl) {
          if (!arrows[k] && data.length === 1) {
            var code = data.toUpperCase().charCodeAt(0);
            if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
          }
          ctrl = false;
          post({ t: 'ctrlUsed' });
        }
        post({ t: 'input', data: data });
        return;
      }
      case 'paste':
        term.paste(String(m.text || ''));
        return;
      case 'zoom':
        zoom = Math.max(1, Math.min(4, Number(m.zoom) || 1));
        refit();
        return;
      case 'bottom':
        term.scrollToBottom();
        return;
      case 'focus':
        term.focus();
        return;
      case 'blur':
        term.blur();
        return;
    }
  };
  window.addEventListener('message', function (e) {
    var d = e.data || {};
    if (typeof d.__belugaIn === 'string') w.__beluga(d.__belugaIn);
  });
  post({ t: 'ready' });
})`;

/** The whole page, self-contained: xterm.js and its CSS inline. */
export function terminalPage(opts: { scheme: 'light' | 'dark'; cols: number; rows: number; zoom?: number }): string {
  const theme = TERM_THEMES[opts.scheme];
  const font = 'ui-monospace, "SF Mono", Menlo, "Roboto Mono", "Droid Sans Mono", monospace';
  const boot = { theme: xtermTheme(theme), cols: opts.cols, rows: opts.rows, zoom: opts.zoom ?? 1, font };
  // `</script>` can't appear inside an inline script.
  const safe = (s: string): string => s.replace(/<\/script/gi, '<\\/script');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>${XTERM_CSS}
html,body{margin:0;padding:0;height:100%;background:${theme.background};overflow:hidden;-webkit-tap-highlight-color:transparent}
#wrap{position:absolute;inset:0;overflow:auto;padding:4px;box-sizing:border-box;touch-action:none;scrollbar-width:none}
#wrap::-webkit-scrollbar{display:none}
#term{display:inline-block}
.xterm .xterm-viewport{scrollbar-width:none}
.xterm .xterm-scrollable-element>.scrollbar{display:none!important}
</style></head><body><div id="wrap"><div id="term"></div></div>
<script>${safe(XTERM_JS)}</script>
<script>${PAGE_JS}(${safe(JSON.stringify(boot))});</script>
</body></html>`;
}
