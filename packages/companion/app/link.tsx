import { useFocusEffect } from 'expo-router';
import { Cable, CircleCheck, Download, Hand, Monitor, ShieldAlert, ShieldCheck } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Header, Screen, useScrolled } from '../components/Screen';
import { Button, Card, Pill, Row, T } from '../components/ui';
import { accessibilityOn, addonInstalled, downloadLink, onAccessibilityChange, openAccessibilitySettings } from '../lib/phone';

/**
 * Settings › Get Beluga Link (BLG-390): what Beluga Link is, why it's an app of its own, that
 * Android may block it when it's downloaded, and the two ways to install it: from the Mac over a
 * cable (which Play Protect doesn't block, and which turns it on too), or downloading it here.
 * Once it's installed, what's left is turning it on.
 */
export default function Link() {
  const { scrolled, onScroll } = useScrolled();
  const insets = useSafeAreaInsets();
  const [installed, setInstalled] = useState(addonInstalled());
  const [on, setOn] = useState(accessibilityOn());
  const refresh = useCallback(() => {
    setInstalled(addonInstalled());
    setOn(accessibilityOn());
  }, []);
  // Back from the download, the installer or Android's settings: show what's true now.
  useFocusEffect(refresh);
  useEffect(() => onAccessibilityChange(refresh), [refresh]);

  const section = (title: string) => (
    <T v="eyebrow" style={{ paddingHorizontal: 6 }}>
      {title}
    </T>
  );
  const note = (text: string) => (
    <T v="caption" style={{ paddingHorizontal: 6 }}>
      {text}
    </T>
  );

  return (
    <Screen>
      <Header scrolled={scrolled} back title="Beluga Link" />
      <ScrollView onScroll={onScroll} scrollEventThrottle={32} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40, gap: 12 }}>
        <Animated.View entering={FadeIn.duration(300)} style={{ gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 6 }}>
            {on ? <Pill label="On" tone="mint" Icon={CircleCheck} /> : installed ? <Pill label="Installed, not on yet" tone="butter" /> : <Pill label="Not installed" tone="plain" />}
          </View>
          <T v="body" style={{ paddingHorizontal: 6 }}>
            Beluga Link lets Claude on your Mac look at this phone and tap, type and open apps when you ask it to. You only need it for that: everything else in Beluga works without it.
          </T>

          {section('Why it’s a separate app')}
          {note(
            'To act on the screen, Link needs Android’s Accessibility access. Android’s Play Protect blocks apps with that access when they’re downloaded instead of coming from the Play Store, so if it were part of Beluga, Beluga itself couldn’t be installed. Kept apart, Beluga always installs, and only Link needs the extra step.',
          )}

          {on ? (
            <Card>
              <Row first Icon={CircleCheck} tone="mint" label="Beluga Link is on" sub="Your Mac can use this phone when you allow it" chevron={false} />
            </Card>
          ) : installed ? (
            <>
              {section('Turn it on')}
              <Card>
                <Row first Icon={ShieldCheck} tone="peach" label="Turn on Beluga Link" sub="Android › Accessibility › Beluga Link" onPress={openAccessibilitySettings} />
              </Card>
              {note('If Android says the setting is restricted, open Settings › Apps › Beluga Link, tap ⋮ and Allow restricted settings, then turn it on. Installed from your Mac, Link is turned on for you and this doesn’t come up.')}
            </>
          ) : (
            <>
              {section('Android may block it')}
              <Card>
                <Row
                  first
                  Icon={ShieldAlert}
                  tone="butter"
                  label="App blocked to protect your device"
                  sub="What Android may show for a downloaded Link"
                  chevron={false}
                />
              </Card>
              {note('That’s Play Protect being careful with every downloaded app that asks for Accessibility, not a problem with Link. Installing it from your Mac goes around it.')}

              {section('Install it from your Mac (easiest)')}
              <Card>
                <Row first Icon={Cable} tone="sky" label="1. Connect it to your Mac" sub="With a USB cable" chevron={false} />
                <Row Icon={Monitor} tone="sky" label="2. Set up Beluga Link on the Mac" sub="Settings › Phone" chevron={false} />
                <Row Icon={Hand} tone="sky" label="3. Tap Allow if the phone asks" sub="“Allow USB debugging?”" chevron={false} />
              </Card>
              {note('Or ask Claude on your Mac: “set up Beluga Link on my phone”. Your Mac installs Link and turns it on, with nothing else to do here. It needs USB debugging on; Settings › Phone on your Mac shows how if it’s off.')}

              {section('Or download it yourself')}
              {note('Download it, open it from your notifications and tap Install. If Android blocks it, use your Mac instead. Then come back here to turn it on.')}
              <Button label="Download Beluga Link" Icon={Download} quiet onPress={downloadLink} />
            </>
          )}
        </Animated.View>
      </ScrollView>
    </Screen>
  );
}
