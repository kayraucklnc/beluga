import { CircleHelp, RefreshCw } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import type { Diagnosis } from '../lib/link/diagnose';
import { color } from '../lib/theme';
import { Sheet } from './Sheet';
import { Button, Card, IconBadge, T } from './ui';

/**
 * The "Why?" sheet: what went wrong with the link in plain words, what to do, and (smaller, for the
 * curious) what was tried and how each went. The surface only ever shows the title; codes stay here.
 */
export function WhySheet({ diagnosis, visible, onDismiss, onRetry, window = false }: { readonly diagnosis?: Diagnosis; readonly visible: boolean; readonly onDismiss: () => void; readonly onRetry?: () => void; readonly window?: boolean }) {
  if (!diagnosis) return null;
  return (
    <Sheet visible={visible} onDismiss={onDismiss} window={window} maxHeight={0.8}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: 12, gap: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <IconBadge Icon={CircleHelp} tone="sky" size={40} square />
          <T v="title" style={{ flex: 1 }}>
            {diagnosis.title}
          </T>
        </View>
        <T v="body" c={color.text2}>
          {diagnosis.body}
        </T>
        {diagnosis.tryThis ? (
          <Card tone="mint" r={16} style={{ padding: 12 }}>
            <T v="callout" style={{ fontWeight: '500' }}>
              {diagnosis.tryThis}
            </T>
          </Card>
        ) : null}
        {diagnosis.detail.length ? (
          <View style={{ gap: 6 }}>
            <T v="eyebrow">What was tried</T>
            {diagnosis.detail.map((line, i) => (
              <T key={i} v="caption" c={color.text3}>
                {line}
              </T>
            ))}
          </View>
        ) : null}
        {diagnosis.retry && onRetry ? (
          <Button
            label="Try again"
            Icon={RefreshCw}
            onPress={() => {
              onDismiss();
              onRetry();
            }}
          />
        ) : null}
      </ScrollView>
    </Sheet>
  );
}
