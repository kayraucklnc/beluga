import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams } from 'expo-router';
import { Maximize2, Plus, RotateCcw, SquareTerminal, Trash2 } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyBar } from '../components/KeyBar';
import { KeyboardLift } from '../components/KeyboardLift';
import { Options } from '../components/Options';
import { Header, Screen } from '../components/Screen';
import { type TermHandle, type TermPageMsg, TermView } from '../components/TermView';
import { haptic, IconBadge, More, Pill, Press, T } from '../components/ui';
import { useLink } from '../lib/hooks';
import { kv } from '../lib/kv';
import { calls } from '../lib/link/calls';
import type { TerminalView, TerminalsView, Topic } from '../lib/link/protocol';
import { store, type TermFrame } from '../lib/store';
import { terminalPage } from '../lib/terminal/page';
import { color, scheme, tint } from '../lib/theme';

/**
 * A worktree's terminal on the phone (BLG-42): the very session the Mac's terminal dock shows.
 * Both see the same output as it comes, and either can type. xterm.js draws it (bundled, in a
 * WebView) at the Mac's size: fitted to the screen's width, a pinch zooms in, one finger scrolls
 * back. Above the keyboard, what a phone keyboard lacks: Esc, Tab, Ctrl and the arrows, and ••• for
 * |, ~, / and paste. Output streams only while this screen is open, coalesced on the Mac to ~30 a second.
 */

export default function Terminal() {
  const { topic, key: wanted, title } = useLocalSearchParams<{ topic: string; key?: string; title?: string }>();
  const t = topic as Topic;
  const insets = useSafeAreaInsets();
  const link = useLink();
  const opened = useRef(false);
  const page = useRef<TermHandle>(null);
  const ready = useRef(false);
  const queued = useRef<object[]>([]);
  const [term, setTerm] = useState<TerminalView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [status, setStatus] = useState<{ running: boolean; exit?: number | null; gone?: boolean; cols: number; rows: number } | undefined>();
  const [ctrl, setCtrl] = useState(false);
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [others, setOthers] = useState<TerminalView[]>([]);
  // Opening again (another terminal, or one started again) attaches afresh.
  const [gen, setGen] = useState(0);

  const send = (msg: object) => {
    if (ready.current) page.current?.send(msg);
    else queued.current.push(msg);
  };

  const open = (opts: { key?: string; fresh?: boolean } = {}) => {
    setError(undefined);
    store.call<TerminalView>(calls.termOpen(t, opts), { queue: false }).then(
      (v) => {
        if (!v) return;
        setTerm(v);
        setStatus({ running: v.running, cols: v.cols, rows: v.rows, ...(v.exit !== undefined ? { exit: v.exit } : {}) });
        setGen((g) => g + 1);
      },
      (e: Error) => setError(e.message),
    );
  };
  // Opened once the link is open (a cold start dials first).
  useEffect(() => {
    if (link.phase !== 'open' || opened.current) return;
    opened.current = true;
    open(wanted ? { key: wanted } : {});
  }, [t, wanted, link.phase]);

  // The page is made once per terminal (at its size then); later sizes, and the output, are messages.
  const html = useMemo(() => (term ? terminalPage({ scheme, cols: term.cols, rows: term.rows, zoom: kv.get<number>('term-zoom') ?? 1 }) : undefined), [term?.key]);
  useEffect(() => {
    ready.current = false;
    queued.current = [];
  }, [html]);

  // Stream it while this screen is open (the store attaches again when the link or the app comes back).
  useEffect(() => {
    if (!term) return;
    return store.attachTerm(term.key, (f: TermFrame) => {
      if (f.t === 'term_data') return send({ t: 'data', data: f.data, ...(f.reset ? { reset: true } : {}) });
      setStatus({ running: f.running, cols: f.cols, rows: f.rows, ...(f.exit !== undefined ? { exit: f.exit } : {}), ...(f.gone ? { gone: true } : {}) });
      send({ t: 'size', cols: f.cols, rows: f.rows });
    });
  }, [term?.key, gen]);

  const onPage = (m: TermPageMsg) => {
    if (m.t === 'ready') {
      ready.current = true;
      for (const q of queued.current.splice(0)) page.current?.send(q);
      return;
    }
    if (m.t === 'input' && term) {
      if (!store.termInput(term.key, m.data)) store.toast({ text: 'Your Mac is away, so that wasn’t sent.', tone: 'warn' });
      return;
    }
    if (m.t === 'ctrlUsed') return setCtrl(false);
    if (m.t === 'zoom') kv.set('term-zoom', m.zoom);
  };

  const toggleCtrl = () => {
    send({ t: 'ctrl', on: !ctrl });
    setCtrl(!ctrl);
  };
  const paste = async () => {
    const text = await Clipboard.getStringAsync().catch(() => '');
    if (text) send({ t: 'paste', text });
    else store.toast({ text: 'Nothing to paste', tone: 'info' });
  };

  const showMenu = () => {
    setMenu(true);
    store.call<TerminalsView>(calls.terminals(t), { queue: false }).then(
      (v) => setOthers(v?.terminals ?? []),
      () => undefined,
    );
  };

  const away = link.phase !== 'open';
  const ended = status && !status.running;
  return (
    <Screen>
      <Header
        back
        title={term?.label ?? 'Terminal'}
        eyebrow={['Shared with your Mac', status ? `${status.cols}×${status.rows}` : undefined].filter(Boolean).join(' · ')}
        lead={<IconBadge Icon={SquareTerminal} tone="lavender" size={30} />}
        right={<More onPress={showMenu} label="Terminal options" />}
      />
      <KeyboardLift>
        <View style={{ flex: 1, marginHorizontal: 10, borderRadius: 16, overflow: 'hidden', backgroundColor: scheme === 'dark' ? '#17171A' : '#FBFBFC', borderWidth: 0.5, borderColor: color.hairline }}>
          {error ? (
            <Animated.View entering={FadeIn} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30, gap: 12 }}>
              <IconBadge Icon={SquareTerminal} tone="rose" size={44} />
              <T v="callout" style={{ textAlign: 'center' }}>
                {error}
              </T>
              <Press onPress={() => open(wanted ? { key: wanted } : {})}>
                <T v="callout" c={color.info}>
                  Try again
                </T>
              </Press>
            </Animated.View>
          ) : html ? (
            <TermView key={`${term?.key}`} ref={page} html={html} onMessage={onPage} />
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 }}>
              <ActivityIndicator color={color.text2} />
              <T v="caption">Opening the terminal on your Mac…</T>
            </View>
          )}
        </View>
        {ended || away ? (
          <Animated.View entering={FadeIn} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 14, marginTop: 8 }}>
            <Pill label={away ? 'Your Mac is away' : status?.gone ? 'This terminal closed' : `Ended${status?.exit !== undefined && status.exit !== null ? ` · exit ${status.exit}` : ''}`} tone={away ? 'butter' : 'plain'} />
            {!away && term ? (
              <Press onPress={() => open(status?.gone ? {} : { key: term.key })} style={{ height: 30, paddingHorizontal: 12, borderRadius: 15, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: tint.mint }}>
                <RotateCcw color={color.ok} size={14} />
                <T v="caption" c={color.ok} style={{ fontWeight: '700' }}>
                  {status?.gone ? 'Open its shell' : 'Start again'}
                </T>
              </Press>
            ) : null}
          </Animated.View>
        ) : null}
        {/* What a phone keyboard lacks, above it: the essentials, and ••• for the rest. */}
        <KeyBar ctrl={ctrl} onKey={(key) => send({ t: 'key', key })} onCtrl={toggleCtrl} onPaste={() => void paste()} bottom={insets.bottom} />
      </KeyboardLift>
      <Options
        visible={menu}
        onClose={() => setMenu(false)}
        title={term?.label}
        options={[
          ...others
            .filter((o) => o.key !== term?.key)
            .map((o) => ({ Icon: SquareTerminal, label: o.label, sub: o.running ? undefined : 'Ended', tone: 'lavender' as const, onPress: () => open({ key: o.key }) })),
          { Icon: Plus, label: 'New terminal', tone: 'mint', onPress: () => open({ fresh: true }) },
          {
            Icon: Maximize2,
            label: 'Fit to the screen',
            tone: 'sky',
            onPress: () => {
              kv.set('term-zoom', 1);
              send({ t: 'zoom', zoom: 1 });
            },
          },
          { Icon: Trash2, label: 'Close terminal…', tone: 'rose', hidden: !term || !status?.running, onPress: () => setConfirm(true) },
        ]}
      />
      <Options
        visible={confirm}
        onClose={() => setConfirm(false)}
        title={`End ${term?.label ?? 'this terminal'} on your Mac? What runs in it stops.`}
        options={[
          {
            Icon: Trash2,
            label: 'Close for both',
            tone: 'rose',
            onPress: () => {
              if (!term) return;
              store.call(calls.termClose(term.key), { queue: false }).then(
                () => store.toast({ text: `${term.label} closed`, tone: 'ok' }),
                (e: Error) => store.toast({ text: e.message, tone: 'error' }),
              );
            },
          },
        ]}
      />
    </Screen>
  );
}
