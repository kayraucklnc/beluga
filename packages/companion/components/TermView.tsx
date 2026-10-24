import { type ComponentType, type Ref, useImperativeHandle, useRef } from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent, type WebViewNavigation, type WebViewProps } from 'react-native-webview';

// Its class's props are `WebViewProps & P` with P = undefined, which TypeScript reads as never.
const Web = WebView as unknown as ComponentType<WebViewProps & { ref?: Ref<WebView> }>;

/** The page's messages out (lib/terminal/page.ts). */
export type TermPageMsg = { readonly t: 'ready' } | { readonly t: 'input'; readonly data: string } | { readonly t: 'ctrlUsed' } | { readonly t: 'zoom'; readonly zoom: number };
export interface TermHandle {
  /** A message into the page (`window.__beluga`). */
  send(msg: object): void;
}

/**
 * The terminal's page in a WebView (BLG-42): xterm.js from the app's own bundle, nothing loaded
 * from the network. Messages in go through injectJavaScript, out through postMessage.
 */
export function TermView({ html, onMessage, style, ref }: { readonly html: string; readonly onMessage: (m: TermPageMsg) => void; readonly style?: StyleProp<ViewStyle>; readonly ref?: Ref<TermHandle> }) {
  const web = useRef<WebView>(null);
  useImperativeHandle(ref, () => ({
    send: (msg) => web.current?.injectJavaScript(`window.__beluga && window.__beluga(${JSON.stringify(JSON.stringify(msg))});true;`),
  }));
  return (
    <Web
      ref={web}
      source={{ html, baseUrl: 'about:blank' }}
      originWhitelist={['*']}
      style={[{ flex: 1, backgroundColor: 'transparent' }, style]}
      onMessage={(e: WebViewMessageEvent) => {
        try {
          onMessage(JSON.parse(e.nativeEvent.data) as TermPageMsg);
        } catch {
          // not ours
        }
      }}
      // Nothing but the page itself: no navigation, no files, no zooming the page (pinch is the terminal's).
      onShouldStartLoadWithRequest={(r: WebViewNavigation) => r.url === 'about:blank' || r.url.startsWith('data:')}
      javaScriptEnabled
      domStorageEnabled={false}
      allowFileAccess={false}
      allowsLinkPreview={false}
      setBuiltInZoomControls={false}
      scalesPageToFit={false}
      keyboardDisplayRequiresUserAction={false}
      hideKeyboardAccessoryView
      overScrollMode="never"
      bounces={false}
      scrollEnabled={false}
      textZoom={100}
      cacheEnabled={false}
    />
  );
}
