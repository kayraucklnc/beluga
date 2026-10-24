import { Braces, FileCode, FileImage, FileText, Folder } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import type { Tone } from './ui';

/** A file's icon and pastel by its name (a worktree's Files, BLG-42): folders sky, code lavender, pictures peach. */
const CODE = /\.(m?[jt]sx?|c[jt]s|py|rb|go|rs|swift|kt|java|c|h|cc|cpp|hpp|m|mm|cs|sh|bash|zsh|css|scss|less|html?|vue|sql|lua|php|ya?ml|toml)$/i;

export function fileIcon(name: string, dir: boolean): { Icon: LucideIcon; tone: Tone } {
  if (dir) return { Icon: Folder, tone: 'sky' };
  if (/\.(png|jpe?g|gif|webp|svg|heic|ico)$/i.test(name)) return { Icon: FileImage, tone: 'peach' };
  if (/\.(json|jsonc|json5|lock)$/i.test(name)) return { Icon: Braces, tone: 'butter' };
  if (CODE.test(name) || /^(Dockerfile|Makefile)$/.test(name)) return { Icon: FileCode, tone: 'lavender' };
  if (/\.(md|mdx|markdown)$/i.test(name)) return { Icon: FileText, tone: 'mint' };
  return { Icon: FileText, tone: 'plain' };
}
