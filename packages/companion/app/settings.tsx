import { router } from 'expo-router';
import { AtSign, Bell, ChevronDown, ChevronUp, CircleCheck, Hand, HardDrive, Info, LogOut, Monitor, Moon, MoonStar, Network, SlidersHorizontal, Smartphone, Sun } from 'lucide-react-native';
import { Segments } from '../components/Segments';
import { useEffect, useState } from 'react';
import { Platform, ScrollView, Switch, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Header, Screen, useScrolled } from '../components/Screen';
import { Card, haptic, Pill, Row, T } from '../components/ui';
import { appearance, type Choice } from '../lib/appearance';
import { useLink, useSupports, useView } from '../lib/hooks';
import { calls } from '../lib/link/calls';
import type { HomeView } from '../lib/link/protocol';
import { COMPANION_PROTO } from '../lib/link/protocol';
import { type NotifyPrefs, permission, prefs, setPrefs } from '../lib/notifications';
import { pathLabel } from '../lib/link/diagnose';
import { sizeOf } from '../components/Outputs';
import { useSaved } from '../lib/saved';
import { totalBytes } from '../lib/saved-list';
import { store } from '../lib/store';
import { color, ink } from '../lib/theme';

/**
 * The phone's own settings. On top: your Mac, notifications on or off, Storage, sign out. Everything else
 * (each kind of notification, the demo's switches, versions). Appearance sits with the basics under Advanced.
 */
type KeepAwake = NonNullable<HomeView['mac']['keepAwake']>;

export default function Settings() {
  const { scrolled, onScroll } = useScrolled();
  const insets = useSafeAreaInsets();
  const link = useLink();
  const [p, setP] = useState<NotifyPrefs>(prefs());
  const [perm, setPerm] = useState<string>('');
  const [asleep, setAsleep] = useState(store.demo?.sleeping ?? false);
  const [confirm, setConfirm] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [look, setLook] = useState<Choice>(appearance.get());
  const saved = useSaved();
  const home = useView<HomeView>('home');
  const canKeepAwake = useSupports('keepAwake');
  const [awake, setAwake] = useState<KeepAwake | undefined>(undefined);
  const keepAwake = awake ?? home?.data.mac.keepAwake ?? 'off';
  const chooseAwake = (mode: KeepAwake) => {
    haptic.tap();
    setAwake(mode);
    void store.call(calls.keepAwake(mode), { queue: false }).catch(() => {
      setAwake(undefined);
      store.toast({ text: 'Your Mac is away: change this when it’s linked.', tone: 'warn' });
    });
  };
  useEffect(() => {
    void permission(false).then(setPerm);
  }, []);

  const save = (next: NotifyPrefs) => {
    haptic.tap();
    setP(next);
    setPrefs(next);
    if ((next.needsYou || next.done || next.mentions) && perm !== 'granted') void permission(true).then(setPerm);
  };
  const all = p.needsYou || p.done || p.mentions;
  const toggle = (on: boolean, onChange: () => void) => (
    <View pointerEvents="none">
      <Switch value={on} onValueChange={onChange} trackColor={{ true: ink.mint, false: color.hairlineStrong }} thumbColor={color.white} {...(Platform.OS === 'web' ? ({ activeThumbColor: color.white } as object) : {})} />
    </View>
  );

  return (
    <Screen>
      <Header scrolled={scrolled} back title="Settings" />
      <ScrollView onScroll={onScroll} scrollEventThrottle={32} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40, gap: 20 }}>
        <Animated.View entering={FadeInDown.duration(300)}>
          <Card>
            <Row first Icon={Monitor} tone="mint" label={link.mac?.name ?? link.pairing?.macName ?? 'Your Mac'} sub={link.mode === 'demo' ? 'Demo Mac' : `Beluga ${link.mac?.version ?? ''}`} right={<Pill label={link.phase === 'open' ? 'Linked' : link.phase === 'asleep' ? 'Asleep' : 'Away'} tone={link.phase === 'open' ? 'mint' : 'sky'} />} />
            <Row Icon={Bell} tone="butter" label="Notifications" sub={perm === 'denied' ? 'Off in Android settings' : undefined} right={toggle(all, () => {})} onPress={() => save({ needsYou: !all, done: !all, mentions: !all })} chevron={false} />
            <Row Icon={HardDrive} tone="sky" label="Storage" sub={saved.length ? `${saved.length} saved · ${sizeOf(totalBytes(saved))}` : 'What Beluga keeps on this phone'} onPress={() => router.push('/storage')} />
            <Row
              Icon={LogOut}
              tone="rose"
              label={confirm ? 'Tap again to sign out' : link.mode === 'demo' ? 'Leave the demo' : 'Sign out'}
              onPress={async () => {
                if (!confirm) {
                  haptic.warn();
                  setConfirm(true);
                  return;
                }
                const r = await store.signOut();
                if (link.mode === 'bare' && !r.onMac) store.toast({ text: 'Signed out here. Your Mac was away: remove this phone there too (Settings › Phone).', tone: 'warn' });
                router.replace('/pair');
              }}
              chevron={false}
            />
          </Card>
        </Animated.View>

            <View style={{ gap: 8 }}>
              <T v="eyebrow" style={{ paddingHorizontal: 6 }}>
                Appearance
              </T>
              <Segments
                value={look}
                onChange={(c: Choice) => {
                  setLook(c);
                  appearance.set(c);
                }}
                options={[
                  { key: 'system', label: 'System', Icon: Smartphone },
                  { key: 'light', label: 'Light', Icon: Sun },
                  { key: 'dark', label: 'Dark', Icon: Moon },
                ]}
              />
            </View>

        <Card>
          <Row first Icon={SlidersHorizontal} tone="lavender" label="Advanced" onPress={() => setAdvanced((a) => !a)} chevron={false} right={advanced ? <ChevronUp color={color.text3} size={18} /> : <ChevronDown color={color.text3} size={18} />} />
        </Card>

        {advanced ? (
          <Animated.View entering={FadeIn.duration(250)} style={{ gap: 20 }}>
            {link.mode === 'bare' ? (
              <View style={{ gap: 8 }}>
                <T v="eyebrow" style={{ paddingHorizontal: 6 }}>
                  Connection
                </T>
                <Card>
                  <Row
                    first
                    Icon={Network}
                    tone={link.path === 'relay' ? 'lavender' : 'mint'}
                    label={link.phase === 'open' && link.path ? pathLabel(link.path) : link.diagnosis?.title ?? 'Not linked right now'}
                    sub={link.phase === 'open' && link.path === 'relay' ? 'A direct connection didn’t work on this network; the relay carries only encrypted bytes.' : undefined}
                    chevron={false}
                  />
                </Card>
              </View>
            ) : null}
            {link.mode !== 'demo' && canKeepAwake ? (
              <View style={{ gap: 8 }}>
                <T v="eyebrow" style={{ paddingHorizontal: 6 }}>
                  Keep your Mac awake
                </T>
                <Segments
                  value={keepAwake}
                  onChange={chooseAwake}
                  options={[
                    { key: 'off', label: 'Never' },
                    { key: 'power', label: 'On power' },
                    { key: 'always', label: 'Always' },
                  ]}
                />
                <T v="caption" c={color.text3} style={{ paddingHorizontal: 6 }}>
                  A sleeping Mac can’t be reached or woken from here, so Beluga keeps it from sleeping. Its display still sleeps; closing the lid still sleeps it.
                </T>
              </View>
            ) : null}
            <View style={{ gap: 8 }}>
              <T v="eyebrow" style={{ paddingHorizontal: 6 }}>
                Notify me about
              </T>
              <Card>
                <Row first Icon={Hand} tone="peach" label="Needs you" right={toggle(p.needsYou, () => {})} onPress={() => save({ ...p, needsYou: !p.needsYou })} chevron={false} />
                <Row Icon={CircleCheck} tone="mint" label="Done" sub="Things you asked from the phone" right={toggle(p.done, () => {})} onPress={() => save({ ...p, done: !p.done })} chevron={false} />
                <Row Icon={AtSign} tone="sky" label="Mentions" right={toggle(p.mentions, () => {})} onPress={() => save({ ...p, mentions: !p.mentions })} chevron={false} />
              </Card>
            </View>

            {link.mode === 'demo' ? (
              <View style={{ gap: 8 }}>
                <T v="eyebrow" style={{ paddingHorizontal: 6 }}>
                  Demo
                </T>
                <Card>
                  <Row
                    first
                    Icon={MoonStar}
                    tone="sky"
                    label="Mac asleep"
                    sub="See the phone without its Mac"
                    right={toggle(asleep, () => {})}
                    chevron={false}
                    onPress={() => {
                      setAsleep(!asleep);
                      store.setDemoAsleep(!asleep);
                    }}
                  />
                </Card>
              </View>
            ) : null}

            <Card>
              <Row first Icon={Info} tone="plain" label="About" sub={`App 0.16.0 · link ${COMPANION_PROTO.major}.${COMPANION_PROTO.minor}${link.mac ? ` · Mac ${link.mac.version}` : ''}`} />
            </Card>
          </Animated.View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
