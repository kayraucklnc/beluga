"""The README's second infographic: one project, a worktree per task, a Claude in each, all at once.
   python3 scripts/readme/worktrees-svg.py  ->  assets/worktrees.svg"""
from pathlib import Path

DUR = 9.0
W, H = 960, 300
FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
TASKS = [  # (worktree, what Claude is doing, seconds to finish)
    ("add-auth", "writing src/auth.ts", 4.2),
    ("fix-webhooks", "running npm test", 6.0),
    ("new-hero", "editing hero.tsx", 5.0),
]


def bar(y, done_at):
    k = f"{done_at / DUR:.4f}"
    return f'''
    <rect x="650" y="{y - 5}" width="160" height="10" rx="5" fill="#e5e5ea"/>
    <rect x="650" y="{y - 5}" width="0" height="10" rx="5" fill="#b4693f">
      <animate attributeName="width" dur="{DUR}s" repeatCount="indefinite" keyTimes="0;0.06;{k};1" values="0;0;160;160"/>
      <animate attributeName="fill" dur="{DUR}s" repeatCount="indefinite" keyTimes="0;{k};{k};1" values="#b4693f;#b4693f;#2f8a4c;#2f8a4c" calcMode="discrete"/>
    </rect>
    <g opacity="0">
      <animate attributeName="opacity" dur="{DUR}s" repeatCount="indefinite" keyTimes="0;{k};{(done_at + 0.3) / DUR:.4f};0.97;1" values="0;0;1;1;0"/>
      <text x="824" y="{y + 4}" font-size="12.5" font-weight="600" fill="#2f8a4c">✓ ready to merge</text>
    </g>'''


rows = []
for i, (name, doing, t) in enumerate(TASKS):
    y = 70 + i * 80
    rows.append(f'''
  <path d="M 190 150 C 260 150, 250 {y}, 320 {y}" fill="none" stroke="#c7c7cc" stroke-width="2"/>
  <rect x="320" y="{y - 22}" width="620" height="44" rx="10" fill="#ffffff" stroke="#e1e1e6"/>
  <text x="338" y="{y + 4.5}" font-size="13" font-weight="600" fill="#1d1d1f">🌿 {name}</text>
  <text x="476" y="{y + 4.5}" font-size="12" fill="#8a4a26">›_ {doing}</text>{bar(y, t)}''')

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="{FONT}" role="img" aria-label="One project, a worktree per task: add-auth, fix-webhooks and new-hero each get their own folder, branch and Claude, all working at once, each ready to merge when done.">
  <rect width="{W}" height="{H}" rx="18" fill="#f6f6f8"/>
  <rect x="24" y="118" width="166" height="64" rx="12" fill="#ffffff" stroke="#e1e1e6"/>
  <text x="107" y="146" text-anchor="middle" font-size="14" font-weight="700" fill="#1d1d1f">📁 bob-api</text>
  <text x="107" y="165" text-anchor="middle" font-size="11" fill="#8e8e93">main stays untouched</text>
  {"".join(rows)}
  <text x="480" y="284" text-anchor="middle" font-size="11" fill="#8e8e93">say what you want · Klaud makes a worktree (folder + branch + Claude) named for it · they all work at once</text>
</svg>
'''
out = Path(__file__).resolve().parents[2] / 'assets' / 'worktrees.svg'
out.write_text(svg)
print(out)
