/**
 * Max effort's message box: flames licking up around it and a pinch of confetti from the caret
 * with every character you type. One canvas over the box (a little larger, for the flames to rise
 * into), drawn only while Max is on and the window is showing. Pure drawing, no React.
 */

export interface FireBox {
  /** The box's place in the canvas (CSS pixels). */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface Flame {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  decay: number;
  size: number;
}

interface Bit {
  x: number;
  y: number;
  vx: number;
  vy: number;
  spin: number;
  turn: number;
  life: number;
  color: string;
  shape: 0 | 1 | 2;
}

/** Hot to cool: what a flame is at each age (as it rises it cools and fades). */
const HEAT = ['#ffe08a', '#ffbe55', '#ff8f45', '#f4563a', '#c9407a'] as const;
/** The confetti: ember colours with a few cool pastels for contrast. */
const CONFETTI = ['#ffd166', '#ff9f68', '#ff6b6b', '#b8a4ff', '#7fd6f5', '#8fe3b0', '#ffc2e2'] as const;

/** A tongue of flame in one colour (a teardrop, point up), drawn once and stamped many times. */
function sprite(color: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 48;
  c.height = 80;
  const g = c.getContext('2d')!;
  g.beginPath();
  g.moveTo(24, 2);
  g.bezierCurveTo(30, 22, 44, 36, 44, 54);
  g.bezierCurveTo(44, 68, 35, 78, 24, 78);
  g.bezierCurveTo(13, 78, 4, 68, 4, 54);
  g.bezierCurveTo(4, 36, 18, 22, 24, 2);
  const grad = g.createRadialGradient(24, 58, 2, 24, 50, 34);
  grad.addColorStop(0, color);
  grad.addColorStop(0.55, `${color}b0`);
  grad.addColorStop(1, `${color}00`);
  g.fillStyle = grad;
  g.filter = 'blur(2px)';
  g.fill();
  return c;
}

export class MaxFire {
  private readonly back: CanvasRenderingContext2D;
  private readonly front: CanvasRenderingContext2D;
  /** On a dark box flames add light; on a light one they're painted (adding would wash out to white). */
  private dark = true;
  private readonly sprites = HEAT.map(sprite);
  private flames: Flame[] = [];
  private bits: Bit[] = [];
  private box: FireBox = { x: 0, y: 0, w: 0, h: 0 };
  private raf = 0;
  private last = 0;
  /** How fierce it burns (typing stokes it; it settles back on its own). */
  private heat = 0.35;
  private focused = false;

  /** Flames go on `behind` (under the box, so they lick out from its edges); confetti on `over`. */
  constructor(
    private readonly behind: HTMLCanvasElement,
    private readonly over: HTMLCanvasElement,
  ) {
    this.back = behind.getContext('2d')!;
    this.front = over.getContext('2d')!;
  }

  resize(width: number, height: number, box: FireBox, dark: boolean): void {
    const dpr = window.devicePixelRatio || 1;
    for (const [c, g] of [[this.behind, this.back], [this.over, this.front]] as const) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.box = box;
    this.dark = dark;
  }

  focus(on: boolean): void {
    this.focused = on;
  }

  /** A character typed at (x, y): a burst of confetti there, and the fire flares. */
  burst(x: number, y: number, n = 9): void {
    this.heat = Math.min(1, this.heat + 0.12);
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.95;
      const speed = 1.6 + Math.random() * 2.6;
      this.bits.push({
        x,
        y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed - 0.6,
        spin: Math.random() * Math.PI,
        turn: (Math.random() - 0.5) * 0.4,
        life: 1,
        color: CONFETTI[(Math.random() * CONFETTI.length) | 0]!,
        shape: (Math.random() * 3) as 0 | 1 | 2,
      });
    }
    if (this.bits.length > 400) this.bits.splice(0, this.bits.length - 400);
  }

  start(): void {
    if (this.raf) return;
    this.last = performance.now();
    const tick = (now: number): void => {
      const dt = Math.min(3, (now - this.last) / 16.67);
      this.last = now;
      this.step(dt);
      this.draw();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.back.clearRect(0, 0, this.behind.width, this.behind.height);
    this.front.clearRect(0, 0, this.over.width, this.over.height);
  }

  /** A point on the box's edge, mostly along the top and up the sides (flames rise). */
  private edge(): { x: number; y: number; side: number } {
    const { x, y, w, h } = this.box;
    const r = Math.random();
    // Born just inside the edge, so each flame comes out from behind the box.
    if (r < 0.7) return { x: x + 8 + Math.random() * (w - 16), y: y + 10, side: 0 };
    if (r < 0.85) return { x: x + 6, y: y + 10 + Math.random() * (h - 14), side: -1 };
    return { x: x + w - 6, y: y + 10 + Math.random() * (h - 14), side: 1 };
  }

  private step(dt: number): void {
    const target = this.focused ? 0.55 : 0.35;
    this.heat += (target - this.heat) * 0.02 * dt;
    // New flames: more the hotter it burns, and more along a wider box.
    for (let born = (this.box.w / 9) * this.heat * dt * 0.35; born > 0; born--) {
      if (born < 1 && Math.random() > born) break;
      const p = this.edge();
      this.flames.push({
        x: p.x,
        y: p.y,
        vx: p.side * (0.35 + Math.random() * 0.4) + (Math.random() - 0.5) * 0.25,
        vy: -(0.45 + Math.random() * 0.9) * (0.7 + this.heat * 0.6),
        life: 1,
        decay: 0.022 + Math.random() * 0.022,
        size: 7 + Math.random() * 9 * (0.6 + this.heat),
      });
    }
    for (const f of this.flames) {
      f.x += (f.vx + Math.sin((f.y + f.life * 40) * 0.08) * 0.25) * dt;
      f.y += f.vy * dt;
      f.vy -= 0.015 * dt;
      f.life -= f.decay * dt;
    }
    this.flames = this.flames.filter((f) => f.life > 0);
    for (const b of this.bits) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.vy += 0.14 * dt;
      b.vx *= 0.985;
      b.spin += b.turn * dt;
      b.life -= 0.016 * dt;
    }
    this.bits = this.bits.filter((b) => b.life > 0);
  }

  private draw(): void {
    const b0 = this.back;
    b0.clearRect(0, 0, this.behind.width, this.behind.height);
    b0.globalCompositeOperation = this.dark ? 'lighter' : 'source-over';
    for (const f of this.flames) {
      const age = 1 - f.life;
      const s = this.sprites[Math.min(HEAT.length - 1, (age * HEAT.length) | 0)]!;
      const w = f.size * (0.5 + f.life * 0.7);
      const h = w * 1.7;
      b0.globalAlpha = Math.min(1, f.life * 1.6) * (this.dark ? 0.42 : 0.5);
      b0.drawImage(s, f.x - w / 2, f.y - h * 0.75, w, h);
    }
    b0.globalAlpha = 1;
    const g = this.front;
    g.clearRect(0, 0, this.over.width, this.over.height);
    for (const b of this.bits) {
      g.globalAlpha = Math.min(1, b.life * 2);
      g.fillStyle = b.color;
      g.save();
      g.translate(b.x, b.y);
      g.rotate(b.spin);
      if (b.shape === 0) g.fillRect(-1.5, -3, 3, 6);
      else if (b.shape === 1) {
        g.beginPath();
        g.arc(0, 0, 1.8, 0, Math.PI * 2);
        g.fill();
      } else {
        g.beginPath();
        for (let k = 0; k < 4; k++) {
          const a = (k * Math.PI) / 2;
          g.lineTo(Math.cos(a) * 3.2, Math.sin(a) * 3.2);
          g.lineTo(Math.cos(a + Math.PI / 4) * 1.1, Math.sin(a + Math.PI / 4) * 1.1);
        }
        g.fill();
      }
      g.restore();
    }
    g.globalAlpha = 1;
  }
}

/** Where the caret is in a textarea, relative to the textarea (a hidden copy of it, measured). */
export function caretPoint(el: HTMLTextAreaElement): { x: number; y: number } {
  const css = getComputedStyle(el);
  const mirror = document.createElement('div');
  for (const prop of ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing', 'tabSize'] as const) {
    mirror.style[prop] = css[prop];
  }
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' });
  mirror.textContent = el.value.slice(0, el.selectionEnd ?? el.value.length);
  const mark = document.createElement('span');
  mark.textContent = '​';
  mirror.appendChild(mark);
  document.body.appendChild(mirror);
  const point = { x: mark.offsetLeft, y: mark.offsetTop - el.scrollTop + parseFloat(css.lineHeight || '20') / 2 };
  mirror.remove();
  return point;
}
