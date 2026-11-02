import { router } from 'expo-router';
import { X } from 'lucide-react-native';
import { useEffect } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GraphCard } from '../components/render/Graph';
import { TextTable } from '../components/render/Block';
import { ViewCard } from '../components/render/ViewCard';
import { Screen } from '../components/Screen';
import { Press, T } from '../components/ui';
import { allowTurning, fullShown } from '../lib/fullscreen';
import { color } from '../lib/theme';

/**
 * A table, chart, view or graph full screen (BLG-71): the whole width for its columns, and the
 * one page of the app that turns sideways with the phone.
 */
export default function Data() {
  const insets = useSafeAreaInsets();
  const f = fullShown();
  useEffect(() => {
    allowTurning(true);
    return () => allowTurning(false);
  }, []);
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const viewName: Record<string, string> = { chart: 'Chart', gantt: 'Timeline', heatmap: 'Heatmap', calendar: 'Activity', stats: 'Numbers', code: 'Code', colors: 'Colors' };
  const title = f?.kind === 'view' ? (f.view.title ?? viewName[f.view.type] ?? 'Table') : f?.kind === 'graph' ? (f.graph.title ?? 'Graph') : 'Table';
  return (
    <Screen>
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 16, paddingBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: color.bg }}>
        <T v="heading" numberOfLines={1} style={{ flex: 1 }}>
          {title}
        </T>
        <Press onPress={close} accessibilityLabel="Close" hitSlop={10} style={{ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: color.sunken }}>
          <X color={color.text2} size={18} />
        </Press>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 8 + Math.max(insets.left, insets.right), paddingBottom: insets.bottom + 24 }}>
        {!f ? (
          <T v="callout" style={{ padding: 16 }}>
            Nothing to show.
          </T>
        ) : f.kind === 'view' ? (
          <ViewCard view={f.view} {...(f.at ? { at: f.at } : {})} full />
        ) : f.kind === 'graph' ? (
          <GraphCard graph={f.graph} full />
        ) : (
          <TextTable text={f.text} full />
        )}
      </ScrollView>
    </Screen>
  );
}
