import { ScrollView, Text, View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import type { ProseView } from '../../lib/link/protocol';
import { color, radius, tint, type } from '../../lib/theme';

/**
 * Math in Claude's words (BLG-87): typeset on the Mac with MathJax (src/companion/math-svg.ts) and
 * drawn here as the SVG it made, in the text's color. Its size is in ex, about 0.45 of the font
 * size. Math the Mac couldn't typeset shows its TeX, monospaced.
 */

export type MathMap = NonNullable<ProseView['math']>;

const EX = 0.45;

/** MathJax's own data-* attributes mean nothing here (and the web warns about them). */
const clean = (svg: string): string => svg.replace(/ data-[\w-]+="[^"]*"/g, '');

/** A `$…$` in a line of text: inline, on the text's baseline. */
export function InlineMath({ tex, math, size, ink }: { readonly tex: string; readonly math?: MathMap; readonly size: number; readonly ink: string }) {
  const m = math?.[`I${tex}`];
  if (!m) return <Text style={[type.mono, { fontSize: size * 0.87, color: color.claude, backgroundColor: tint.claude }]}>{` ${tex} `}</Text>;
  const ex = size * EX;
  return (
    <View accessibilityLabel={tex} style={{ width: m.w * ex, height: m.h * ex, transform: [{ translateY: -m.v * ex }] }}>
      <SvgXml xml={clean(m.svg)} width={m.w * ex} height={m.h * ex} color={ink} />
    </View>
  );
}

/** A math block (`$$…$$`, ```math): centered, and it scrolls sideways when it's wider than the screen. */
export function MathBlock({ tex, math, size = 17 }: { readonly tex: string; readonly math?: MathMap; readonly size?: number }) {
  const m = math?.[`D${tex}`];
  if (!m) {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ borderRadius: radius.m - 2, backgroundColor: color.code }} contentContainerStyle={{ padding: 12, flexGrow: 1, justifyContent: 'center' }}>
        <Text selectable style={[type.mono, { color: color.text, fontSize: 13 }]}>
          {tex}
        </Text>
      </ScrollView>
    );
  }
  const ex = size * EX;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingVertical: 6, paddingHorizontal: 4 }}>
      <View accessibilityLabel={tex} accessible>
        <SvgXml xml={clean(m.svg)} width={m.w * ex} height={m.h * ex} color={color.text} />
      </View>
    </ScrollView>
  );
}
