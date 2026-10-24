import { CircleCheck, CircleX, Clock } from 'lucide-react-native';
import { View } from 'react-native';
import { type Send, sends } from '../lib/sends';
import { color } from '../lib/theme';
import { Press, T } from './ui';

/** Under a bubble of yours the Mac hasn't confirmed: its state in words, and Retry / Remove once it failed. */
export function SendStatus({ s }: { s: Send }) {
  if (s.state === 'failed') {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4, marginRight: 4 }}>
        <CircleX color={color.error} size={12} />
        <T v="caption" c={color.error} numberOfLines={2} style={{ flexShrink: 1 }}>
          Not sent{s.error ? ` · ${s.error}` : ''}
        </T>
        <Press onPress={() => sends.retry(s.id)} hitSlop={8} accessibilityLabel="Try again">
          <T v="caption" c={color.text} style={{ fontWeight: '700' }}>
            Retry
          </T>
        </Press>
        <Press onPress={() => sends.remove(s.id)} hitSlop={8} accessibilityLabel="Remove">
          <T v="caption" c={color.text2} style={{ fontWeight: '700' }}>
            Remove
          </T>
        </Press>
      </View>
    );
  }
  const words = s.state === 'waiting' ? 'Waits for your Mac' : s.state === 'unsure' ? 'Checking it got there…' : s.state === 'sent' ? 'Sent' : 'Sending…';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4, marginRight: 4 }}>
      {s.state === 'sent' ? <CircleCheck color={color.text2} size={12} /> : <Clock color={color.text2} size={12} />}
      <T v="caption">{words}</T>
    </View>
  );
}
