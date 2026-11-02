import { Code } from 'lucide-react-native';
import { store } from '../../lib/store';
import { color } from '../../lib/theme';
import { Press, T } from '../ui';

/** A code block Claude wrote, folded to a chip: no code on the phone. */
export function CodeChip({ lang, lines }: { readonly lang?: string; readonly lines: number }) {
  return (
    <Press onPress={() => store.toast({ text: 'Code stays on your Mac.', tone: 'info' })} style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 7, height: 32, paddingHorizontal: 12, borderRadius: 12, backgroundColor: color.code }}>
      <Code color={color.text2} size={15} strokeWidth={1.9} />
      <T v="caption" c={color.text2} style={{ fontWeight: '600' }}>
        Code · {lines} {lines === 1 ? 'line' : 'lines'}
      </T>
    </Press>
  );
}
