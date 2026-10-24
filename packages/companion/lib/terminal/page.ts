import { TERM_FONT_CSS, TERM_FONT_FAMILY } from './font.generated';
import { XTERM_CSS, XTERM_JS } from './xterm.generated';
import { FIT_MIN, FONT_DEFAULT, FONT_MAX, FONT_MIN, LINE_HEIGHT, PAD, type TermFont } from './zoom';

/**
 * The terminal's page (BLG-42): xterm.js, bundled (no CDN), drawing the Mac's PTY output in a
 * WebView on the phone (an iframe in the web build). The app and the page talk in small JSON
 * messages:
 *
 * - in (`window.__beluga(msg)`): `data` (the PTY's bytes; `reset` clears first), `size` (the
 *   Mac's grid), `ctrl` (the key bar's Ctrl, for the next key), `key`, `paste`, `font` (a size in
 *   px, or `fit`), `bottom`, `focus`, `blur`;
 * - out (ReactNativeWebView.postMessage, or the parent's postMessage): `ready`, `input` (keys typed
 *   here), `ctrlUsed`, `font` (the size drawn now and whether it's fitting; after a pinch too).
 *
 * The grid is always the Mac's (cols × rows), never resized or rewrapped here (BLG-108): the text
 * is drawn at a readable size (JetBrains Mono, 13 px unless changed), and what's wider or taller
 * than the screen is a pan away; "fit" draws the whole width instead. One finger pans the grid,
 * then scrolls back; two pinch the text size; a tap brings up the keyboard. Output keeps the
 * cursor in view unless a finger just moved the view.
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
 * can't be a function's toString(). Called with the boot options by terminalPage. The size maths
 * mirrors lib/terminal/zoom.ts (tested there), with its numbers passed in `boot`.
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
  var start = function () {
    var cols = boot.cols;
    var rows = boot.rows;
    // The width of one cell per px of font size, measured once in this font.
    var probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-size:100px;font-family:' + boot.font;
    probe.textContent = 'WWWWWWWWWWWWWWWWWWWW';
    document.body.appendChild(probe);
    var perPx = probe.getBoundingClientRect().width / 20 / 100 || 0.6;
    probe.remove();
    // The text size: a size in px (clamped), or what fits the Mac's columns to the screen's width.
    var clamp = function (n) { return Math.round(Math.min(boot.max, Math.max(boot.min, Number(n) || boot.def)) * 2) / 2; };
    var fitSize = function () { return Math.max(boot.fitMin, Math.min(boot.max, Math.floor(((wrap.clientWidth - boot.pad * 2) / (cols * perPx)) * 4) / 4)); };
    var fit = boot.size === 'fit';
    var size = fit ? boot.def : clamp(boot.size);
    var sizeNow = function () { return fit ? fitSize() : size; };
    var term = new w.Terminal({ cols: cols, rows: rows, fontFamily: boot.font, fontSize: sizeNow(), lineHeight: boot.lineHeight, letterSpacing: 0, fontWeight: '400', fontWeightBold: '700', minimumContrastRatio: 4.5, customGlyphs: true, rescaleOverlappingGlyphs: true, theme: boot.theme, scrollback: 5000, allowProposedApi: true, cursorBlink: false, macOptionIsMeta: true, drawBoldTextInBrightColors: false });
    term.open(box);
    // WebGL draws box drawing, blocks and braille itself, lined up to the cell (the bundled font
    // has none of them); without WebGL, or when its context is lost, xterm's DOM renderer draws.
    var renderer = 'dom';
    try {
      var gl = new w.WebglAddon.WebglAddon();
      gl.onContextLoss(function () { gl.dispose(); });
      term.loadAddon(gl);
      renderer = 'webgl';
    } catch (e) {
      // no WebGL here: the DOM renderer it is
    }
    document.documentElement.setAttribute('data-renderer', renderer);
    // The app is told the size drawn (for A-/A+ and to keep it), when it changes.
    var told;
    var tell = function () {
      var now = term.options.fontSize;
      if (told && told.size === now && told.fit === fit) return;
      told = { size: now, fit: fit };
      post({ t: 'font', size: now, fit: fit });
    };
    // A cell's size on screen, from what xterm.js drew.
    var cell = function () {
      var el = box.querySelector('.xterm-screen');
      return el && el.clientWidth ? { w: el.clientWidth / term.cols, h: el.clientHeight / term.rows } : { w: term.options.fontSize * perPx, h: term.options.fontSize * 1.3 };
    };
    // Keep the cursor in view as output comes, unless a finger moved the view just now. Sideways
    // only while typing here (a full-screen program's cursor wanders).
    var touched = 0, typed = 0;
    var follow = function () {
      if (Date.now() - touched < 1500) return;
      var b = term.buffer.active;
      if (b.viewportY !== b.baseY) return;
      var c = cell();
      var y = boot.pad + b.cursorY * c.h;
      if (y + c.h > wrap.scrollTop + wrap.clientHeight) wrap.scrollTop = y + c.h + boot.pad - wrap.clientHeight;
      else if (y < wrap.scrollTop) wrap.scrollTop = Math.max(0, y - boot.pad);
      if (Date.now() - typed > 1500) return;
      var x = boot.pad + b.cursorX * c.w;
      if (x + c.w > wrap.scrollLeft + wrap.clientWidth) wrap.scrollLeft = x + c.w * 6 - wrap.clientWidth;
      else if (x < wrap.scrollLeft) wrap.scrollLeft = Math.max(0, x - c.w * 6);
    };
    var input = function (data) {
      typed = Date.now();
      touched = 0;
      post({ t: 'input', data: data });
    };
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
      input(data);
    });
    // A new size, keeping the point at (fx, fy) of the view where it was.
    var apply = function (next, fx, fy) {
      if (Math.abs(term.options.fontSize - next) < 0.01) return;
      var bw = box.offsetWidth || 1, bh = box.offsetHeight || 1;
      var rx = (wrap.scrollLeft + fx) / bw, ry = (wrap.scrollTop + fy) / bh;
      term.options.fontSize = next;
      wrap.scrollLeft = rx * box.offsetWidth - fx;
      wrap.scrollTop = ry * box.offsetHeight - fy;
    };
    var refit = function () {
      apply(sizeNow(), 0, 0);
      follow();
      tell();
    };
    window.addEventListener('resize', refit);

    // Touch: one finger pans the grid (then scrolls back), two pinch the text size, a tap brings up the keyboard.
    var tap, pinch, carry = 0, frame = 0;
    var dist = function (e) { return Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); };
    wrap.addEventListener('touchstart', function (e) {
      touched = Date.now();
      if (e.touches.length === 2) {
        var r = wrap.getBoundingClientRect();
        var now = term.options.fontSize;
        pinch = { d: dist(e) || 1, size: now, to: now, x: (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top };
        tap = undefined;
      } else if (e.touches.length === 1 && !pinch) tap = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(), moved: false };
    }, { passive: true });
    wrap.addEventListener('touchmove', function (e) {
      e.preventDefault();
      touched = Date.now();
      if (pinch) {
        if (e.touches.length !== 2) return;
        pinch.to = clamp((pinch.size * dist(e)) / pinch.d);
        // One re-render a frame, however fast the fingers move.
        if (!frame) frame = requestAnimationFrame(function () {
          frame = 0;
          if (!pinch) return;
          fit = false;
          apply(pinch.to, pinch.x, pinch.y);
        });
        return;
      }
      if (!tap || e.touches.length !== 1) return;
      var t = e.touches[0];
      var dx = t.clientX - tap.x, dy = t.clientY - tap.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) tap.moved = true;
      wrap.scrollLeft -= dx;
      // Down shows what's above: the grid's top first, then the scrollback. Up the other way round.
      var b = term.buffer.active;
      if ((dy > 0 && wrap.scrollTop > 0) || (dy < 0 && b.viewportY >= b.baseY)) wrap.scrollTop -= dy;
      else {
        var line = cell().h;
        carry += dy;
        var n = Math.trunc(carry / line);
        if (n) { term.scrollLines(-n); carry -= n * line; }
      }
      tap.x = t.clientX;
      tap.y = t.clientY;
    }, { passive: false });
    wrap.addEventListener('touchend', function (e) {
      touched = Date.now();
      if (pinch) {
        if (e.touches.length) return;
        fit = false;
        size = pinch.to;
        apply(size, pinch.x, pinch.y);
        pinch = undefined;
        tell();
        return;
      }
      // A tap: the keyboard comes up, and the cursor stays in view above it.
      if (tap && !tap.moved && Date.now() - tap.t < 350) { touched = 0; term.focus(); }
      tap = undefined;
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
      term.write(d, function () { writing = false; follow(); flush(); });
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
          input(data);
          return;
        }
        case 'paste':
          typed = Date.now();
          touched = 0;
          term.paste(String(m.text || ''));
          return;
        case 'font':
          if (m.fit) fit = true;
          else { fit = false; size = clamp(m.size); }
          touched = 0;
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
    follow();
    tell();
    post({ t: 'ready' });
  };
  // The font is inline (a data URL), so this is quick; it must be in before cells are measured.
  var started = false;
  var go = function () { if (!started) { started = true; start(); } };
  if (document.fonts && document.fonts.load) {
    Promise.all([document.fonts.load('400 13px ' + boot.family), document.fonts.load('700 13px ' + boot.family)]).then(go, go);
    setTimeout(go, 1000);
  } else go();
})`;

/** The whole page, self-contained: xterm.js, its CSS and its font inline. */
export function terminalPage(opts: { scheme: 'light' | 'dark'; cols: number; rows: number; font?: TermFont }): string {
  const theme = TERM_THEMES[opts.scheme];
  // JetBrains Mono (bundled) first; what it lacks (CJK, emoji) comes from the system's monospace.
  // Box drawing, blocks and braille are drawn by the WebGL renderer, not taken from a font.
  const family = `"${TERM_FONT_FAMILY}"`;
  const font = `${family}, ui-monospace, Menlo, "Droid Sans Mono", "Roboto Mono", monospace`;
  const boot = { theme: xtermTheme(theme), cols: opts.cols, rows: opts.rows, size: opts.font ?? FONT_DEFAULT, font, family, min: FONT_MIN, max: FONT_MAX, def: FONT_DEFAULT, fitMin: FIT_MIN, lineHeight: LINE_HEIGHT, pad: PAD };
  // `</script>` can't appear inside an inline script.
  const safe = (s: string): string => s.replace(/<\/script/gi, '<\\/script');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>${TERM_FONT_CSS}${XTERM_CSS}
html,body{margin:0;padding:0;height:100%;background:${theme.background};overflow:hidden;-webkit-tap-highlight-color:transparent;-webkit-text-size-adjust:100%}
#wrap{position:absolute;inset:0;overflow:auto;padding:${PAD}px;box-sizing:border-box;touch-action:none;scrollbar-width:none}
#wrap::-webkit-scrollbar{display:none}
#term{display:inline-block;vertical-align:top}
.xterm{font-variant-ligatures:none;font-feature-settings:"liga" 0,"calt" 0;-webkit-font-smoothing:antialiased}
.xterm .xterm-viewport{scrollbar-width:none}
.xterm .xterm-scrollable-element>.scrollbar{display:none!important}
</style></head><body><div id="wrap"><div id="term"></div></div>
<script>${safe(XTERM_JS)}</script>
<script>${PAGE_JS}(${safe(JSON.stringify(boot))});</script>
</body></html>`;
}
