import { promises as fs } from 'node:fs';
import chalk from 'chalk';
import { decodeImage } from '../../image/decode.js';
import { imageToLines } from '../../image/render.js';
import type { Line } from '../../shared/text.js';

function toAnsi(line: Line): string {
  return line
    .map((s) => {
      let c = chalk;
      if (s.color) c = c.hex(s.color);
      if (s.bg) c = c.bgHex(s.bg);
      return s.color || s.bg ? c(s.text) : s.text;
    })
    .join('');
}

/** `beluga view <image> [--ascii]`: print an image right in the terminal. */
export async function runView(args: readonly string[]): Promise<number> {
  const file = args.find((a) => !a.startsWith('-'));
  if (!file) {
    process.stderr.write('Usage: beluga view <image.png|jpg|gif|svg> [--ascii] [--width N]\n');
    return 1;
  }
  try {
    const image = decodeImage(await fs.readFile(file), file);
    const w = args.indexOf('--width');
    const cols = w >= 0 ? Number(args[w + 1]) || 80 : Math.min(process.stdout.columns || 80, 120);
    const rows = Math.max(4, (process.stdout.rows || 40) - 3);
    const lines = imageToLines(image, cols, rows, { mode: args.includes('--ascii') ? 'ascii' : 'blocks' });
    process.stdout.write(`${lines.map(toAnsi).join('\n')}\n${chalk.hex('#7d8590')(`${file} · ${image.width}×${image.height}`)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`beluga view: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
