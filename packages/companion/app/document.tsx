import { useLocalSearchParams } from 'expo-router';
import { FileText, Laptop } from 'lucide-react-native';
import { createElement, useEffect, useMemo } from 'react';
import { ActivityIndicator, Linking, Platform, View } from 'react-native';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { sizeOf } from '../components/Outputs';
import { Header, Screen } from '../components/Screen';
import { Card, Press, T } from '../components/ui';
import { useFile } from '../lib/hooks';
import { calls } from '../lib/link/calls';
import { store } from '../lib/store';
import { color, radius, tint } from '../lib/theme';
import { documentLook, kindWords, quietHtml } from '../../../src/shared/typed-cells';

/** The most of a page or an SVG fetched to show it (a piece is 192 KB; more than this opens on the Mac). */
const PAGE_MAX = 4 * 1024 * 1024;

/**
 * A kept table's document or storage object on the phone (BLG-386), streamed from the Mac by its ref
 * (nothing is kept: the Mac reads it, or fetches a storage object through a link signed there, and
 * holds it in memory a moment; the phone's copy lives in memory, a PDF in the cache emptied at each
 * launch). A page shows with nothing allowed to run or load (its policy first, and no JavaScript; a
 * link it holds opens in the browser), an SVG as a picture, a PDF on iPhone; anything else says what
 * it is, with Open on your Mac.
 */
export default function DocumentScreen() {
  const insets = useSafeAreaInsets();
  const p = useLocalSearchParams<{ ref: string; name: string; mime: string; sentinelId: string; metric: string; column: string; value: string; storage?: string }>();
  const look = documentLook(p.mime ?? '');
  const svg = p.mime === 'image/svg+xml';
  const page = look === 'html' || svg;
  const pdf = look === 'pdf' && Platform.OS === 'ios';
  const text = useFile(page ? p.ref : undefined, 'text');
  const full = useFile(pdf ? p.ref : undefined, 'full');
  // A page longer than one piece: the rest, a piece at a time, up to PAGE_MAX.
  const more = text?.status === 'ready' && (text.size ?? 0) > text.got && text.got < PAGE_MAX;
  useEffect(() => {
    if (more && p.ref) store.fetch(p.ref, 'text', true);
  }, [more, text?.got, p.ref]);
  const html = useMemo(() => {
    if (!page || text?.status !== 'ready' || more || text.text === undefined) return undefined;
    if (svg) return quietHtml(`<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#fff"><img style="max-width:100%" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(text.text)}"></body>`);
    return quietHtml(`<meta name="viewport" content="width=device-width, initial-scale=1">${text.text}`);
  }, [page, svg, text?.status, text?.text, more]);
  const openOnMac = () =>
    void store.call(calls.documentOpen(p.sentinelId, p.metric, p.column, p.value, p.storage === '1', p.name)).then(
      () => store.toast({ text: `${p.name} is open on your Mac`, tone: 'ok' }),
      (e: Error) => store.toast({ text: e.message, tone: 'error' }),
    );
  // A link in the page opens in the browser; the page itself never goes anywhere.
  const stay = (nav: WebViewNavigation): boolean => {
    if (nav.url.startsWith('about:') || nav.url.startsWith('data:')) return true;
    if (/^https?:\/\//i.test(nav.url)) void Linking.openURL(nav.url);
    return false;
  };
  const got = page ? text : pdf ? full : undefined;
  const failed = got?.status === 'error' ? (got.error ?? 'It didn’t come') : undefined;
  const shown = html !== undefined || (pdf && full?.status === 'ready' && full.uri);
  const loading = (page || pdf) && !shown && !failed;
  const kind = kindWords(p.name ?? '', p.mime ?? '');
  return (
    <Screen>
      <Header title={p.name ?? 'Document'} subtitle={kind} back />
      {shown ? (
        <View style={{ flex: 1, paddingBottom: insets.bottom }}>
          {Platform.OS === 'web' && html !== undefined ? (
            // The web build (the demo, screenshots): a frame that runs and loads nothing.
            createElement('iframe', { srcDoc: html, sandbox: '', title: p.name, style: { flex: 1, border: 0, width: '100%', height: '100%', background: '#fff' } })
          ) : (
            <WebView
              style={{ flex: 1, backgroundColor: '#fff' }}
              originWhitelist={['about:*', 'data:*', 'file://*']}
              source={html !== undefined ? { html } : { uri: full!.uri! }}
              javaScriptEnabled={false}
              domStorageEnabled={false}
              allowFileAccess={pdf}
              allowsLinkPreview={false}
              setSupportMultipleWindows={false}
              onShouldStartLoadWithRequest={html !== undefined ? stay : undefined}
              accessibilityLabel={p.name}
            />
          )}
        </View>
      ) : loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 }}>
          <ActivityIndicator color={color.text3} />
          <T v="caption">{p.storage === '1' ? 'Fetching it from Storage on your Mac…' : 'Getting it from your Mac…'}</T>
        </View>
      ) : (
        <View style={{ padding: 16, gap: 14 }}>
          <Card style={{ padding: 16, gap: 12 }}>
            <View style={{ width: 44, height: 44, borderRadius: radius.m, backgroundColor: tint.info, alignItems: 'center', justifyContent: 'center' }}>
              <FileText size={22} color={color.info} />
            </View>
            <View style={{ gap: 4 }}>
              <Meta label="Kind" value={kind} />
              {got?.size ? <Meta label="Size" value={sizeOf(got.size)} /> : null}
              {p.storage === '1' ? <Meta label="In Storage" value={p.value} /> : null}
            </View>
            <T v="callout" c={color.text2}>
              {failed ?? (text?.status === 'ready' && (text.size ?? 0) > PAGE_MAX ? 'It’s too big to show on the phone: open it on your Mac.' : 'The phone can’t show this kind of file: open it on your Mac.')}
            </T>
            <Press onPress={openOnMac} accessibilityLabel="Open on your Mac" style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: 14, borderRadius: 18, backgroundColor: color.primary, alignSelf: 'flex-start' }}>
              <Laptop size={15} color={color.onPrimary} />
              <T v="callout" c={color.onPrimary} style={{ fontWeight: '600' }}>
                Open on your Mac
              </T>
            </Press>
          </Card>
        </View>
      )}
    </Screen>
  );
}

function Meta({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 12 }}>
      <T v="caption" c={color.text3} style={{ width: 74 }}>
        {label}
      </T>
      <T v="caption" c={color.text} style={{ flex: 1 }} selectable>
        {value}
      </T>
    </View>
  );
}
