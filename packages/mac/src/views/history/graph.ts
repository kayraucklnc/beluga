/**
 * The commit graph, as plain data: which lane each commit sits in and the lines through each row
 * (branches running past, a branch joining its parent, a merge reaching over). Rows are drawn
 * one SVG each (HistoryList.tsx). Pure, so it's tested on its own (tests/mac-history.test.ts).
 *
 * Commits come newest first with children before their parents (git log --date-order). A lane
 * waits for a commit (a parent of something above); a commit takes the leftmost lane waiting for
 * it, and every other lane waiting for it joins there. Its first parent continues in its lane,
 * other parents (a merge) reach to a lane already waiting for them or a new one.
 */

export interface GraphCommit {
  readonly hash: string;
  readonly parents: readonly string[];
}

/** A line in one row, in lane units: from the top edge or the node's middle, to the middle or the bottom edge. */
export interface Segment {
  readonly from: number;
  readonly to: number;
  readonly fromY: 'top' | 'mid';
  readonly toY: 'mid' | 'bottom';
  /** Index into the palette (a lane keeps its color for as long as it runs). */
  readonly color: number;
}

export interface GraphRow {
  /** The commit's lane. */
  readonly lane: number;
  readonly color: number;
  readonly segments: readonly Segment[];
  /** Lanes in use in this row (for its width). */
  readonly width: number;
  /** Two or more parents. */
  readonly merge: boolean;
}

export interface Graph {
  readonly rows: readonly GraphRow[];
  /** The widest row. */
  readonly width: number;
}

type Lane = { readonly hash: string; readonly color: number } | null;

const firstFree = (lanes: readonly Lane[], skip = -1): number => {
  const i = lanes.findIndex((l, j) => l === null && j !== skip);
  return i < 0 ? Math.max(lanes.length, skip + 1) : i;
};

const trim = (lanes: Lane[]): Lane[] => {
  let end = lanes.length;
  while (end > 0 && lanes[end - 1] === null) end--;
  return lanes.slice(0, end);
};

export function layoutGraph(commits: readonly GraphCommit[]): Graph {
  let lanes: Lane[] = [];
  let nextColor = 0;
  let widest = 0;
  const rows: GraphRow[] = [];
  for (const c of commits) {
    const before = lanes;
    const next: Lane[] = [...lanes];
    const segments: Segment[] = [];
    let lane = before.findIndex((l) => l?.hash === c.hash);
    let color: number;
    if (lane < 0) {
      // Nothing waits for it: a branch's tip, in the first free lane.
      lane = firstFree(next);
      color = nextColor++;
    } else {
      color = before[lane]!.color;
    }
    // Every lane waiting for this commit comes into its node.
    before.forEach((l, j) => {
      if (l?.hash !== c.hash) return;
      segments.push({ from: j, to: lane, fromY: 'top', toY: 'mid', color: l.color });
      next[j] = null;
    });
    // Lanes passing by.
    before.forEach((l, j) => {
      if (l && l.hash !== c.hash) segments.push({ from: j, to: j, fromY: 'top', toY: 'bottom', color: l.color });
    });
    const [first, ...others] = c.parents;
    if (first) {
      next[lane] = { hash: first, color };
      segments.push({ from: lane, to: lane, fromY: 'mid', toY: 'bottom', color });
    } else {
      next[lane] = null;
    }
    for (const p of others) {
      const waiting = next.findIndex((l) => l?.hash === p);
      if (waiting >= 0) {
        segments.push({ from: lane, to: waiting, fromY: 'mid', toY: 'bottom', color: next[waiting]!.color });
        continue;
      }
      const k = firstFree(next, lane);
      const fresh = nextColor++;
      while (next.length < k) next.push(null);
      next[k] = { hash: p, color: fresh };
      segments.push({ from: lane, to: k, fromY: 'mid', toY: 'bottom', color: fresh });
    }
    lanes = trim(next);
    const width = Math.max(before.length, lanes.length, lane + 1);
    widest = Math.max(widest, width);
    rows.push({ lane, color, segments, width, merge: c.parents.length > 1 });
  }
  return { rows, width: widest };
}

/** Lane colors: calm, distinct in light and dark (the first is the main line's). */
export const LANE_COLORS = ['#5b8def', '#3fa776', '#d39a2c', '#a46ed0', '#2fa4a0', '#d0675a', '#7f72e6', '#b98a5e'];

export const laneColor = (i: number): string => LANE_COLORS[i % LANE_COLORS.length]!;

/** An SVG path for a segment in a row `h` tall, lanes `w` apart, starting `x0` in. */
export function segmentPath(seg: Segment, h: number, w: number, x0: number): string {
  const x1 = x0 + seg.from * w;
  const x2 = x0 + seg.to * w;
  const y1 = seg.fromY === 'top' ? 0 : h / 2;
  const y2 = seg.toY === 'mid' ? h / 2 : h;
  if (x1 === x2) return `M${x1} ${y1}V${y2}`;
  const mid = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
}
