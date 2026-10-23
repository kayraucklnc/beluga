"""The README's animated infographic: your Claude asks a friend's Claude, Mac to Mac.
   python3 scripts/readme/flow-svg.py  ->  assets/flow.svg (SMIL: GitHub animates it in <img>)."""
from pathlib import Path

DUR = 12.0  # seconds per loop
W, H = 960, 380
FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"


def show(t1, t2, fade=0.25):
    """Opacity animation: hidden, fades in until t1, shown until t2, faded out by t2 + fade (seconds)."""
    pts = [(0, 0), (max(t1 - fade, 0.01), 0), (t1, 1), (t2, 1), (min(t2 + fade, DUR - 0.01), 0), (DUR, 0)]
    keys = ";".join(f"{t / DUR:.5f}" for t, _ in pts)
    vals = ";".join(str(v) for _, v in pts)
    return f'<animate attributeName="opacity" dur="{DUR}s" repeatCount="indefinite" keyTimes="{keys}" values="{vals}"/>'


def travel(x1, x2, y, t1, t2):
    """Move along x from x1 to x2 between t1 and t2, staying put otherwise."""
    a, b = round(t1 / DUR, 4), round(t2 / DUR, 4)
    return (f'<animateTransform attributeName="transform" type="translate" dur="{DUR}s" repeatCount="indefinite" '
            f'keyTimes="0;{a};{b};1" values="{x1} {y};{x1} {y};{x2} {y};{x2} {y}" calcMode="spline" '
            f'keySplines="0 0 1 1;0.4 0 0.2 1;0 0 1 1"/>')


def mac(x, title, who):
    return f'''
  <g transform="translate({x} 40)">
    <rect width="330" height="290" rx="14" fill="#ffffff" stroke="#d9d9de"/>
    <rect width="330" height="34" rx="14" fill="#f1f1f4"/><rect y="20" width="330" height="14" fill="#f1f1f4"/>
    <circle cx="18" cy="17" r="5" fill="#ff5f57"/><circle cx="34" cy="17" r="5" fill="#febc2e"/><circle cx="50" cy="17" r="5" fill="#28c840"/>
    <text x="165" y="22" text-anchor="middle" font-size="12" font-weight="600" fill="#5d5d63">{title}</text>
    <text x="16" y="276" font-size="11" fill="#8e8e93">{who}</text>
  </g>'''


def bubble(x, y, w, text, fill, color, t1, t2, size=13, h=34):
    return f'''
  <g opacity="0">{show(t1, t2)}
    <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{fill}"/>
    <text x="{x + 12}" y="{y + h / 2 + 4.5}" font-size="{size}" fill="{color}">{text}</text>
  </g>'''


def packet(label, x1, x2, y, t1, t2, color):
    return f'''
  <g opacity="0">{show(t1 - 0.1, t2 + 0.1, 0.15)}
    <g>{travel(x1, x2, y, t1, t2)}
      <rect x="-70" y="-15" width="140" height="30" rx="15" fill="{color}"/>
      <text x="0" y="5" text-anchor="middle" font-size="12" font-weight="600" fill="#fff">{label}</text>
    </g>
  </g>'''


svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="{FONT}" role="img" aria-label="Your Claude asks a friend's Claude: kay types @mia send me a screenshot of your desktop; the request travels Mac to Mac, end-to-end encrypted; a small pop-up on mia's screen asks her; she clicks Allow; her Claude takes the screenshot; the result comes back to kay's Claude.">
  <rect width="{W}" height="{H}" rx="18" fill="#f6f6f8"/>
  {mac(24, "Your Mac · Beluga", "you and your Claude")}
  {mac(606, "Mia’s Mac · browsing in Chrome", "mia and her Claude")}

  <!-- the link between them: no server -->
  <line x1="364" y1="185" x2="596" y2="185" stroke="#c7c7cc" stroke-width="2" stroke-dasharray="5 6">
    <animate attributeName="stroke-dashoffset" from="0" to="-22" dur="1s" repeatCount="indefinite"/>
  </line>
  <text x="480" y="160" text-anchor="middle" font-size="12" fill="#5d5d63">🔒 Mac to Mac, end-to-end encrypted</text>
  <text x="480" y="216" text-anchor="middle" font-size="11" fill="#8e8e93">no server, no host</text>

  <!-- 1. you tag a friend -->
  {bubble(44, 90, 290, "@mia send me a screenshot of your desktop", "#0a84ff", "#fff", 0.3, 11.6, 12.5)}
  {bubble(44, 132, 220, "›_  Claude: asking mia’s Claude…", "#f4e9e2", "#8a4a26", 1.2, 8.6, 12)}

  <!-- 2. the request travels -->
  {packet("📨 request", 400, 560, 185, 1.8, 3.4, "#0a84ff")}

  <!-- 3. the pop-up on mia's screen -->
  <g opacity="0">{show(3.5, 6.2)}
    <rect x="636" y="86" width="270" height="118" rx="12" fill="#ffffff" stroke="#e1e1e6"/>
    <circle cx="660" cy="110" r="12" fill="#f4e9e2"/><text x="660" y="114" text-anchor="middle" font-size="10" fill="#b4693f">›_</text>
    <text x="680" y="107" font-size="11.5" fill="#5d5d63"><tspan font-weight="700" fill="#1d1d1f">kay’s Claude</tspan> wants to</text>
    <text x="680" y="124" font-size="12.5" font-weight="600" fill="#1d1d1f">take a screenshot of your desktop</text>
    <text x="680" y="145" font-size="11" fill="#0a84ff">› See more</text>
    <rect x="648" y="164" width="60" height="24" rx="6" fill="#fff" stroke="#d1d1d6"/><text x="678" y="180" text-anchor="middle" font-size="11">Decline</text>
    <rect x="752" y="164" width="88" height="24" rx="6" fill="#fff" stroke="#d1d1d6"/><text x="796" y="180" text-anchor="middle" font-size="11">Allow Always</text>
    <rect x="846" y="164" width="50" height="24" rx="6" fill="#0a84ff"/><text x="871" y="180" text-anchor="middle" font-size="11" fill="#fff" font-weight="600">Allow</text>
    <!-- her click -->
    <circle cx="871" cy="176" r="0" fill="none" stroke="#0a84ff" stroke-width="2">
      <animate attributeName="r" dur="{DUR}s" repeatCount="indefinite" keyTimes="0;{5.2/DUR:.4f};{5.8/DUR:.4f};1" values="0;0;18;18"/>
      <animate attributeName="opacity" dur="{DUR}s" repeatCount="indefinite" keyTimes="0;{5.2/DUR:.4f};{5.8/DUR:.4f};1" values="0;1;0;0"/>
    </circle>
  </g>
  {bubble(626, 228, 220, "🔔 a pop-up, wherever she is", "#ffffff", "#5d5d63", 3.5, 6.2, 11.5, 28)}

  <!-- 4. her Claude works -->
  {bubble(636, 96, 270, "›_  mia’s Claude: 📸 took a screenshot", "#f4e9e2", "#8a4a26", 6.4, 9.6, 12)}

  <!-- 5. the result comes back -->
  {packet("🖼️ desktop.png", 560, 400, 185, 7.4, 9.0, "#2f8a4c")}
  {bubble(44, 132, 290, "✅ mia’s Claude sent desktop.png", "#e6f4ea", "#1f6b37", 9.1, 11.6, 12.5)}

  <!-- the steps, along the bottom -->
  <g font-size="11" fill="#8e8e93">
    <text x="480" y="358" text-anchor="middle">1 tag a friend · 2 the ask travels · 3 they Allow (or trust you: no pop-up) · 4 their Claude works · 5 the answer comes back</text>
  </g>
</svg>
'''

out = Path(__file__).resolve().parents[2] / 'assets' / 'flow.svg'
out.write_text(svg)
print(out)
