import { ChevronUp, Copy, SquareTerminal } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { ScrollView, Text, type TextStyle, View } from 'react-native';
import { type AnsiName, type Span, TERMINAL_FOLD, type TermLine, readTerminal } from '../../lib/render';
import { alpha, color, ink, radius, scheme, tint, type } from '../../lib/theme';
import { Press, T } from '../ui';
import { copy, SmallChip } from './parts';

/**
 * Terminal output Claude shows (BLG-87), read by the Mac's own reader (src/shared/render/terminal.ts):
 * a sunken monospaced panel that scrolls sideways, prompts muted and commands strong, ANSI colors in
 * a soft palette, errors on a faint rose, warnings on butter, passes in mint. Long output folds to
 * its last lines. Copy copies the output without colors; long-press copies the commands.
 */

type Palette = Record<AnsiName, string>;

// Soft, never neon: readable on the code surface in each theme ("white" stays visible in light).
const LIGHT: Palette = {
  black: '#3A3A3F',
  red: '#B04A5C',
  green: '#2F7A57',
  yellow: '#87691C',
  blue: '#3A6CA3',
  magenta: '#7656A6',
  cyan: '#2A7782',
  white: '#6E6E75',
  brightBlack: '#7A7A80',
  brightRed: '#C2606F',
  brightGreen: '#3D8E68',
  brightYellow: '#9A7B2A',
  brightBlue: '#4C80B8',
  brightMagenta: '#8A6CB8',
  brightCyan: '#3A8C97',
  brightWhite: '#5D5D63',
};
const DARK: Palette = {
  black: '#8B8B92',
  red: '#EFB0BC',
  green: '#9FD6BD',
  yellow: '#E9D58F',
  blue: '#A9C8EC',
  magenta: '#C6B9F0',
  cyan: '#A3D7DD',
  white: '#D6D6DA',
  brightBlack: '#9A9AA1',
  brightRed: '#F4C3CC',
  brightGreen: '#B5E2CD',
  brightYellow: '#F0E0A8',
  brightBlue: '#BFD6F1',
  brightMagenta: '#D5CBF4',
  brightCyan: '#BDE3E7',
  brightWhite: '#ECECEE',
};

const paint = (c: Span['fg']): string | undefined => (c === undefined ? undefined : c.startsWith('#') ? c : (scheme === 'dark' ? DARK : LIGHT)[c as AnsiName]);

function spanStyle(s: Span): TextStyle {
  const fg = paint(s.fg);
  const bg = paint(s.bg);
  return {
    ...(fg ? { color: fg } : {}),
    ...(bg ? { backgroundColor: bg.startsWith('#') && bg.length === 7 ? alpha(bg, 0.22) : bg } : {}),
    ...(s.bold ? { fontWeight: '700' as const } : {}),
    ...(s.dim ? { opacity: 0.6 } : {}),
    ...(s.italic ? { fontStyle: 'italic' as const } : {}),
    ...(s.underline ? { textDecorationLine: 'underline' as const } : {}),
  };
}

function LineView({ line }: { readonly line: TermLine }) {
  const tone = line.kind === 'error' ? tint.rose : line.kind === 'warning' ? tint.butter : undefined;
  const ink0 = line.kind === 'ok' ? ink.mint : color.text;
  return (
    <View style={{ paddingHorizontal: 12, backgroundColor: tone ?? 'transparent' }}>
      <Text style={[type.mono, { fontSize: 12.5, lineHeight: 18, color: ink0, ...(line.kind === 'prompt' ? { fontWeight: '600' as const } : {}) }]}>
        {line.prompt ? <Text style={{ color: color.text3, fontWeight: '400' }}>{line.prompt}</Text> : null}
        {line.spans.length ? line.spans.map((s, i) => <Text key={i} style={spanStyle(s)}>{s.text}</Text>) : ' '}
      </Text>
    </View>
  );
}

export function TerminalView({ text }: { readonly text: string }) {
  const term = useMemo(() => readTerminal(text), [text]);
  const [all, setAll] = useState(false);
  const earlier = all ? 0 : Math.max(0, term.lines.length - TERMINAL_FOLD);
  const shown = earlier ? term.lines.slice(earlier) : term.lines;
  const copyCommands = () => (term.commands.length ? copy(term.commands.join('\n'), term.commands.length === 1 ? 'Copied the command' : `Copied ${term.commands.length} commands`) : copy(term.plain));
  return (
    <View style={{ gap: 8 }}>
      <Press haptics={false} scaleTo={1} onLongPress={copyCommands} delayLongPress={380} accessibilityHint="Long-press to copy the commands" style={{ borderRadius: radius.m - 2, backgroundColor: color.code, overflow: 'hidden', paddingVertical: 10 }}>
        {earlier ? (
          <View style={{ paddingHorizontal: 10, paddingBottom: 8, alignSelf: 'flex-start' }}>
            <SmallChip label={`Show ${earlier} earlier ${earlier === 1 ? 'line' : 'lines'}`} Icon={ChevronUp} onPress={() => setAll(true)} />
          </View>
        ) : null}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ minWidth: '100%' }}>
          <View style={{ flexGrow: 1 }}>
            {shown.map((l, i) => (
              <LineView key={earlier + i} line={l} />
            ))}
          </View>
        </ScrollView>
      </Press>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <SmallChip label="Copy" Icon={Copy} onPress={() => copy(term.plain)} />
        <View style={{ flex: 1 }} />
        <SquareTerminal color={color.text3} size={13} />
        <T v="caption">{term.commands.length ? `${term.commands.length} ${term.commands.length === 1 ? 'command' : 'commands'}` : `${term.lines.length} ${term.lines.length === 1 ? 'line' : 'lines'}`}</T>
      </View>
    </View>
  );
}
