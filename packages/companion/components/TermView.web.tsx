import { type Ref, createElement, useEffect, useImperativeHandle, useRef } from 'react';
import { type StyleProp, View, type ViewStyle } from 'react-native';
import type { TermHandle, TermPageMsg } from './TermView';

export type { TermHandle, TermPageMsg } from './TermView';

/** The web build: the same page in an iframe (srcdoc), messages through postMessage. */
export function TermView({ html, onMessage, style, ref }: { readonly html: string; readonly onMessage: (m: TermPageMsg) => void; readonly style?: StyleProp<ViewStyle>; readonly ref?: Ref<TermHandle> }) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const handler = useRef(onMessage);
  handler.current = onMessage;
  useImperativeHandle(ref, () => ({
    send: (msg) => frame.current?.contentWindow?.postMessage({ __belugaIn: JSON.stringify(msg) }, '*'),
  }));
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const s = (e.data as { __belugaTerm?: unknown } | null)?.__belugaTerm;
      if (typeof s !== 'string') return;
      try {
        handler.current(JSON.parse(s) as TermPageMsg);
      } catch {
        // not ours
      }
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, []);
  return (
    <View style={[{ flex: 1 }, style]}>
      {createElement('iframe', { ref: frame, srcDoc: html, title: 'Terminal', sandbox: 'allow-scripts', style: { border: 0, width: '100%', height: '100%', display: 'block', background: 'transparent' } })}
    </View>
  );
}
