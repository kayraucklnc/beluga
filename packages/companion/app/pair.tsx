import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Device from 'expo-device';
import { router } from 'expo-router';
import { Check, Keyboard, ScanLine, X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, StyleSheet, TextInput, View } from 'react-native';
import Animated, { Easing, FadeIn, FadeInDown, FadeOut, ZoomIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Mark } from '../components/Mark';
import { Button, Card, haptic, IconBadge, Press, T } from '../components/ui';
import { DEVICE_LINK } from '../lib/link/protocol';
import type { PairStep } from '../lib/link/transport';
import { type Mode, store } from '../lib/store';
import { color } from '../lib/theme';

/**
 * Pairing: scan the QR from Mac › Settings › Phone (or type its code), check the four pictures
 * match the Mac's, click Pair there. Or try the demo.
 */
type Stage = 'hello' | 'scan' | 'code' | 'dialing' | 'waiting' | 'paired' | 'failed';

const CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const formatCode = (raw: string): string =>
  raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12)
    .replace(/(.{4})(?=.)/g, '$1-');

export default function Pair() {
  const insets = useSafeAreaInsets();
  const [stage, setStage] = useState<Stage>('hello');
  const [fingerprint, setFingerprint] = useState('');
  const [reason, setReason] = useState('');
  const [macName, setMacName] = useState('');
  const [code, setCode] = useState('');
  const run = useRef<{ cancel(): void } | undefined>(undefined);
  const scanned = useRef(false);

  useEffect(() => () => run.current?.cancel(), []);

  const start = (mode: Mode, input: { link?: string; code?: string }) => {
    run.current?.cancel();
    haptic.commit();
    const name = Device.deviceName ?? Device.modelName ?? (Platform.OS === 'web' ? 'This browser' : 'Phone');
    run.current = store.pair(mode, { ...input, name }, (s: PairStep) => {
      if (s.step === 'dialing') setStage('dialing');
      else if (s.step === 'waiting') {
        setFingerprint(s.fingerprint);
        setStage('waiting');
        haptic.tap();
      } else if (s.step === 'paired') {
        setMacName(s.pairing.macName);
        setStage('paired');
        haptic.success();
        setTimeout(() => router.replace('/(tabs)'), 1400);
      } else {
        setReason(s.reason);
        setStage('failed');
        haptic.warn();
      }
    });
  };

  const cancel = () => {
    run.current?.cancel();
    run.current = undefined;
    scanned.current = false;
    setStage('hello');
  };

  return (
    <View style={{ flex: 1, backgroundColor: color.bg }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, paddingTop: insets.top + 20, paddingBottom: insets.bottom + 20, paddingHorizontal: 24 }}>
        {stage === 'hello' ? <Hello onScan={() => setStage('scan')} onCode={() => setStage('code')} onDemo={() => start('demo', {})} /> : null}

        {stage === 'scan' ? (
          <Scan
            onBack={cancel}
            onCode={() => setStage('code')}
            onLink={(link) => {
              if (scanned.current) return;
              scanned.current = true;
              start('bare', { link });
            }}
          />
        ) : null}

        {stage === 'code' ? (
          <Animated.View key="code" entering={FadeInDown.duration(300)} exiting={FadeOut} style={{ flex: 1 }}>
            <TopBar onBack={cancel} />
            <View style={{ flex: 1, justifyContent: 'center' }}>
              <IconBadge Icon={Keyboard} tone="sky" size={52} />
              <T v="title" style={{ marginTop: 18 }}>
                Type the code
              </T>
              <T v="callout" style={{ marginTop: 6 }}>
                It's under the QR on your Mac.
              </T>
              <Card style={{ marginTop: 24, paddingVertical: 16, paddingHorizontal: 16 }}>
                <TextInput
                  value={code}
                  onChangeText={(t) => setCode(formatCode(t))}
                  placeholder="K7QM-4XPA-R2TD"
                  placeholderTextColor={color.text3}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  autoFocus
                  maxLength={14}
                  style={{ color: color.text, fontSize: 26, fontWeight: '600', letterSpacing: 2.5, textAlign: 'center', fontVariant: ['tabular-nums'], ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) }}
                  onSubmitEditing={() => CODE.test(code) && start('bare', { code })}
                />
              </Card>
            </View>
            <Button label="Pair" Icon={Check} disabled={!CODE.test(code)} onPress={() => start('bare', { code })} />
          </Animated.View>
        ) : null}

        {stage === 'dialing' || stage === 'waiting' ? (
          <Animated.View key="wait" entering={FadeIn.duration(250)} style={{ flex: 1 }}>
            <TopBar onBack={cancel} label="Cancel" />
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              {stage === 'dialing' ? (
                <>
                  <Mark size={72} intro={false} />
                  <ActivityIndicator color={color.text2} style={{ marginTop: 28 }} />
                  <T v="title" style={{ marginTop: 14, textAlign: 'center' }}>
                    Finding your Mac
                  </T>
                </>
              ) : (
                <>
                  <T v="title" style={{ textAlign: 'center' }}>
                    Same on your Mac?
                  </T>
                  <View style={{ flexDirection: 'row', gap: 10, marginTop: 28 }}>
                    {fingerprint
                      .split(/\s+/)
                      .filter(Boolean)
                      .slice(0, 4)
                      .map((e, i) => (
                        <Animated.View key={i} entering={ZoomIn.delay(80 + i * 90).duration(320)}>
                          <Card style={{ width: 70, height: 82, alignItems: 'center', justifyContent: 'center' }}>
                            <T style={{ fontSize: 36, lineHeight: 44 }}>{e}</T>
                          </Card>
                        </Animated.View>
                      ))}
                  </View>
                  <T v="callout" style={{ marginTop: 24, textAlign: 'center', maxWidth: 280 }}>
                    If they match, click Pair on your Mac.
                  </T>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 20 }}>
                    <ActivityIndicator size="small" color={color.text3} />
                    <T v="caption">Waiting</T>
                  </View>
                </>
              )}
            </View>
          </Animated.View>
        ) : null}

        {stage === 'paired' ? (
          <Animated.View key="ok" entering={FadeIn} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Animated.View entering={ZoomIn.duration(360)}>
              <IconBadge Icon={Check} tone="mint" size={72} />
            </Animated.View>
            <Animated.View entering={FadeInDown.delay(250).duration(400)}>
              <T v="hero" style={{ marginTop: 24, textAlign: 'center' }}>
                Paired
              </T>
              <T v="callout" style={{ marginTop: 6, textAlign: 'center' }}>
                with {macName}
              </T>
            </Animated.View>
          </Animated.View>
        ) : null}

        {stage === 'failed' ? (
          <Animated.View key="fail" entering={FadeInDown.duration(300)} style={{ flex: 1 }}>
            <View style={{ flex: 1, justifyContent: 'center' }}>
              <IconBadge Icon={X} tone="rose" size={52} />
              <T v="title" style={{ marginTop: 18 }}>
                That didn't work
              </T>
              <T v="callout" style={{ marginTop: 6 }}>
                {reason}
              </T>
            </View>
            <Button label="Try again" onPress={cancel} />
            <Press onPress={() => start('demo', {})} style={{ alignSelf: 'center', marginTop: 14, padding: 8 }}>
              <T v="callout" c={color.info} style={{ fontWeight: '600' }}>
                Try the demo
              </T>
            </Press>
          </Animated.View>
        ) : null}
      </KeyboardAvoidingView>
    </View>
  );
}

function Hello({ onScan, onCode, onDemo }: { onScan: () => void; onCode: () => void; onDemo: () => void }) {
  const ease = Easing.bezier(0.22, 1, 0.36, 1);
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Mark size={104} delay={100} />
        <Animated.View entering={FadeInDown.delay(700).duration(600).easing(ease)}>
          <T v="hero" style={{ marginTop: 28, textAlign: 'center', fontSize: 32, lineHeight: 38 }}>
            Your Mac,{'\n'}in your pocket
          </T>
        </Animated.View>
        <Animated.View entering={FadeInDown.delay(850).duration(600).easing(ease)} style={{ marginTop: 26, gap: 12, alignSelf: 'center' }}>
          {[
            { Icon: Check, tone: 'mint' as const, text: 'Answer what needs you' },
            { Icon: ScanLine, tone: 'sky' as const, text: 'See what Claude makes' },
            { Icon: Keyboard, tone: 'peach' as const, text: 'Ask your Mac anything' },
          ].map((r) => (
            <View key={r.text} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <IconBadge Icon={r.Icon} tone={r.tone} size={32} />
              <T v="body">{r.text}</T>
            </View>
          ))}
        </Animated.View>
      </View>
      <Animated.View entering={FadeInDown.delay(1000).duration(500).easing(ease)} style={{ gap: 10 }}>
        <Button label="Scan the code" Icon={ScanLine} onPress={onScan} />
        <Button label="Type the code" Icon={Keyboard} quiet onPress={onCode} />
        <Press onPress={onDemo} style={{ alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 16 }}>
          <T v="callout" c={color.info} style={{ fontWeight: '600' }}>
            Try the demo
          </T>
        </Press>
      </Animated.View>
    </View>
  );
}

function TopBar({ onBack, label }: { onBack: () => void; label?: string }) {
  return (
    <View style={{ flexDirection: 'row' }}>
      <Press onPress={onBack} style={{ height: 36, paddingHorizontal: 12, borderRadius: 18, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: color.card }}>
        <X color={color.text2} size={16} />
        <T v="callout" c={color.text}>
          {label ?? 'Back'}
        </T>
      </Press>
    </View>
  );
}

function Scan({ onBack, onCode, onLink }: { onBack: () => void; onCode: () => void; onLink: (link: string) => void }) {
  const [perm, ask] = useCameraPermissions();
  const web = Platform.OS === 'web';
  useEffect(() => {
    if (!web && perm && !perm.granted && perm.canAskAgain) void ask();
  }, [perm?.granted]);
  const live = !web && !!perm?.granted;
  return (
    <Animated.View entering={FadeInDown.duration(300)} style={{ flex: 1 }}>
      <TopBar onBack={onBack} />
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <T v="title" style={{ textAlign: 'center' }}>
          Scan your Mac's code
        </T>
        <T v="callout" style={{ marginTop: 6, textAlign: 'center' }}>
          Mac › Settings › Phone › Pair
        </T>
        <View style={{ width: 264, height: 264, marginTop: 28, borderRadius: 28, overflow: 'hidden', backgroundColor: color.sunken }}>
          {live ? (
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => {
                if (DEVICE_LINK.test(data)) onLink(data);
              }}
            />
          ) : (
            <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14 }]}>
              <IconBadge Icon={ScanLine} tone="sky" size={52} />
              <T v="callout" style={{ textAlign: 'center' }}>
                {web ? 'Scanning works in the phone app.' : 'Beluga needs the camera for this.'}
              </T>
              {!web ? <Button label="Allow camera" quiet onPress={() => void ask()} style={{ height: 40 }} /> : null}
            </View>
          )}
          {live
            ? [0, 1, 2, 3].map((i) => (
                <View key={i} pointerEvents="none" style={[{ position: 'absolute', width: 30, height: 30, borderColor: color.white, borderWidth: 3, borderRadius: 10 }, i % 2 ? { right: 12, borderLeftWidth: 0 } : { left: 12, borderRightWidth: 0 }, i > 1 ? { bottom: 12, borderTopWidth: 0 } : { top: 12, borderBottomWidth: 0 }]} />
              ))
            : null}
        </View>
      </View>
      <Button label="Type the code" Icon={Keyboard} quiet onPress={onCode} />
    </Animated.View>
  );
}
