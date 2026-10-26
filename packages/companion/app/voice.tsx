import { Check, ChevronDown, ChevronUp, Download, Gauge, Languages, Laptop, SlidersHorizontal, Smartphone, Trash2, Zap } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Options, type Option } from '../components/Options';
import { Header, Screen, useScrolled } from '../components/Screen';
import { Segments } from '../components/Segments';
import { Card, haptic, Pill, Row, T, type Tone } from '../components/ui';
import { useLink, useSupports } from '../lib/hooks';
import { calls } from '../lib/link/calls';
import type { VoiceMacView } from '../lib/link/protocol';
import { store } from '../lib/store';
import { color } from '../lib/theme';
import { getPhoneModel, phoneGB, phoneModelReady, removePhoneModel, setVoiceSetting, voiceChoice, voiceSetting } from '../lib/voice';
import { suggestVoice, VOICE_LANGUAGES, VOICE_MODEL_IDS, VOICE_MODELS, VOICE_PRESETS, type VoiceModelId, type VoicePresetId, type VoiceSetting, type VoiceWhere, voiceKnows, voiceSize } from '../../../src/shared/voice-models';

/**
 * Settings › Voice (BLG-142): how the Ask sheet's microphone writes down what you say. Presets
 * first, the one Beluga suggests for this phone and Mac marked (and chosen until you pick another);
 * the language; then, one tap away, your own where and model, and the models on the phone and on
 * the Mac (get one now, or take one off the phone).
 */
const PRESET_LOOK: Record<VoicePresetId, { Icon: typeof Zap; tone: Tone }> = {
  quick: { Icon: Smartphone, tone: 'mint' },
  'best-phone': { Icon: Gauge, tone: 'peach' },
  mac: { Icon: Laptop, tone: 'sky' },
  'mac-fast': { Icon: Zap, tone: 'lavender' },
};

export default function Voice() {
  const { scrolled, onScroll } = useScrolled();
  const insets = useSafeAreaInsets();
  const link = useLink();
  const macVoice = useSupports('voice');
  const [set, setSet] = useState<VoiceSetting>(voiceSetting());
  const [advanced, setAdvanced] = useState(set.preset === 'custom');
  const [langSheet, setLangSheet] = useState(false);
  const [mac, setMac] = useState<VoiceMacView | undefined>();
  const [getting, setGetting] = useState<Partial<Record<VoiceModelId, number>>>({});
  const [, redraw] = useState(0);

  const suggested = suggestVoice({ macVoice, phoneGB: phoneGB(), language: set.language });
  const choice = voiceChoice(set);
  const save = (next: VoiceSetting) => {
    haptic.tap();
    setSet(next);
    setVoiceSetting(next);
    // A Mac model starts coming now, so the first time you speak it's there.
    const c = voiceChoice(next);
    if (c.where === 'mac' && macVoice && link.phase === 'open') void store.call<VoiceMacView>(calls.voicePrepare(c.model), { queue: false }).then(setMac, () => {});
  };

  // The Mac's models, and how far one coming is (every 2 s while one comes).
  const coming = mac?.models.some((m) => m.progress !== undefined) ?? false;
  useEffect(() => {
    if (!macVoice || link.phase !== 'open') return;
    let alive = true;
    const look = () => void store.call<VoiceMacView>(calls.voice(), { queue: false }).then((v) => alive && v && setMac(v), () => {});
    look();
    const t = coming ? setInterval(look, 2000) : undefined;
    return () => {
      alive = false;
      if (t) clearInterval(t);
    };
  }, [macVoice, link.phase, coming]);

  const getHere = (id: VoiceModelId) => {
    haptic.tap();
    setGetting((g) => ({ ...g, [id]: 0 }));
    void getPhoneModel(id, (p) => setGetting((g) => ({ ...g, [id]: p })))
      .then(
        () => store.toast({ text: `${VOICE_MODELS[id].label} is on this phone`, tone: 'ok' }),
        (e: unknown) => store.toast({ text: e instanceof Error ? e.message : 'Couldn’t get it', tone: 'warn' }),
      )
      .finally(() =>
        setGetting((g) => {
          const { [id]: _, ...rest } = g;
          return rest;
        }),
      );
  };
  const removeHere = (id: VoiceModelId) => {
    haptic.warn();
    void removePhoneModel(id).then(() => redraw((n) => n + 1));
  };

  const language = VOICE_LANGUAGES.find((l) => l.code === set.language)?.label ?? set.language;
  const languageOptions: Option[] = VOICE_LANGUAGES.map((l) => ({ Icon: l.code === set.language ? Check : Languages, label: l.label, tone: l.code === set.language ? 'mint' : 'plain', onPress: () => save({ ...set, language: l.code }) }));
  const selected: VoicePresetId | undefined = set.preset === 'custom' ? undefined : set.preset === 'suggested' ? suggested : set.preset;

  return (
    <Screen>
      <Header scrolled={scrolled} back title="Voice" />
      <ScrollView onScroll={onScroll} scrollEventThrottle={32} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40, gap: 20 }}>
        <Animated.View entering={FadeInDown.duration(300)} style={{ gap: 8 }}>
          <T v="caption" c={color.text3} style={{ paddingHorizontal: 6 }}>
            The microphone in Ask writes down what you say, here or on your Mac. Your words go into the field to read over before you send.
          </T>
          <Card>
            {VOICE_PRESETS.map((p, i) => {
              const off = p.where === 'mac' && !macVoice;
              const knows = voiceKnows(p.model, set.language);
              const on = selected === p.id;
              return (
                <Row
                  key={p.id}
                  first={i === 0}
                  Icon={PRESET_LOOK[p.id].Icon}
                  tone={off ? 'plain' : PRESET_LOOK[p.id].tone}
                  label={p.label}
                  sub={off ? 'Needs Beluga on your Mac to be updated' : !knows ? `Doesn’t know ${language}: Whisper writes it instead` : p.sub}
                  right={
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      {p.id === suggested ? <Pill label="Suggested" tone="mint" /> : null}
                      {on ? <Check color={color.primary} size={20} strokeWidth={2.6} /> : null}
                    </View>
                  }
                  // The suggested one follows the suggestion (it may change with your Mac or language).
                  onPress={off ? undefined : () => save({ preset: p.id === suggested ? 'suggested' : p.id, language: set.language })}
                  chevron={false}
                />
              );
            })}
          </Card>
          <T v="caption" c={color.text3} style={{ paddingHorizontal: 6 }}>
            {macVoice ? 'Suggested: your Mac’s GPU writes it down best and fastest, and this phone downloads nothing. Away from your Mac, the phone writes it down itself.' : (phoneGB() ?? 0) >= 8 ? 'Suggested: this phone has the memory for the larger model.' : 'Suggested: the small model suits this phone.'}
          </T>
        </Animated.View>

        <Card>
          <Row first Icon={Languages} tone="butter" label="Language" sub={set.language === 'auto' ? 'It tells which you speak' : 'Only this one: a little more exact'} right={<T v="callout">{language}</T>} onPress={() => setLangSheet(true)} />
        </Card>

        <Card>
          <Row first Icon={SlidersHorizontal} tone="lavender" label="Choose it yourself" sub={set.preset === 'custom' ? `${set.where === 'mac' ? 'On your Mac' : 'On this phone'} · ${VOICE_MODELS[choice.model].label}` : 'Where, which model, what’s downloaded'} onPress={() => setAdvanced((a) => !a)} chevron={false} right={advanced ? <ChevronUp color={color.text3} size={18} /> : <ChevronDown color={color.text3} size={18} />} />
        </Card>

        {advanced ? (
          <Animated.View entering={FadeIn.duration(250)} style={{ gap: 20 }}>
            <View style={{ gap: 8 }}>
              <T v="eyebrow" style={{ paddingHorizontal: 6 }}>
                Where
              </T>
              <Segments<VoiceWhere>
                value={choice.where}
                onChange={(where) => save({ preset: 'custom', where, model: VOICE_MODELS[choice.model].files[where] ? choice.model : 'whisper-turbo', language: set.language })}
                options={[
                  { key: 'phone', label: 'This phone', Icon: Smartphone },
                  ...(macVoice ? [{ key: 'mac' as const, label: 'Your Mac', Icon: Laptop }] : []),
                ]}
              />
            </View>
            <View style={{ gap: 8 }}>
              <T v="eyebrow" style={{ paddingHorizontal: 6 }}>
                Model
              </T>
              <Card>
                {VOICE_MODEL_IDS.filter((id) => VOICE_MODELS[id].files[choice.where]).map((id, i) => {
                  const m = VOICE_MODELS[id];
                  const knows = voiceKnows(id, set.language);
                  return (
                    <Row
                      key={id}
                      first={i === 0}
                      Icon={m.kind === 'parakeet' ? Zap : Gauge}
                      tone={knows ? (m.kind === 'parakeet' ? 'lavender' : 'peach') : 'plain'}
                      label={m.label}
                      sub={!knows ? `Doesn’t know ${language}` : `${voiceSize(m.files[choice.where]!.bytes)} · ${m.languages === 'all' ? 'every language' : 'English and 24 European languages'}`}
                      right={choice.model === id ? <Check color={color.primary} size={20} strokeWidth={2.6} /> : null}
                      onPress={knows ? () => save({ preset: 'custom', where: choice.where, model: id, language: set.language }) : undefined}
                      chevron={false}
                    />
                  );
                })}
              </Card>
            </View>

            <View style={{ gap: 8 }}>
              <T v="eyebrow" style={{ paddingHorizontal: 6 }}>
                On this phone
              </T>
              <Card>
                {VOICE_MODEL_IDS.filter((id) => VOICE_MODELS[id].files.phone).map((id, i) => {
                  const m = VOICE_MODELS[id];
                  const here = phoneModelReady(id);
                  const g = getting[id];
                  return (
                    <Row
                      key={id}
                      first={i === 0}
                      Icon={here ? Trash2 : Download}
                      tone={here ? 'rose' : 'sky'}
                      label={m.label}
                      sub={g !== undefined ? `Getting it · ${Math.round(g * 100)}%` : here ? `${voiceSize(m.files.phone!.bytes)} here · tap to take it off` : `${voiceSize(m.files.phone!.bytes)} · tap to get it now`}
                      onPress={g !== undefined ? undefined : here ? () => removeHere(id) : () => getHere(id)}
                      chevron={false}
                    />
                  );
                })}
              </Card>
            </View>

            {macVoice ? (
              <View style={{ gap: 8 }}>
                <T v="eyebrow" style={{ paddingHorizontal: 6 }}>
                  On your Mac
                </T>
                <Card>
                  {link.phase !== 'open' ? (
                    <Row first Icon={Laptop} tone="plain" label="Your Mac is away" sub="Its models show when it’s linked" chevron={false} />
                  ) : (
                    !mac ? (
                    <Row first Icon={Laptop} tone="plain" label="Looking at your Mac…" chevron={false} />
                  ) : (
                    mac.models.map((m, i) => (
                      <Row
                        key={m.model}
                        first={i === 0}
                        Icon={m.ready ? Check : Download}
                        tone={m.ready ? 'mint' : 'sky'}
                        label={VOICE_MODELS[m.model].label}
                        sub={m.ready ? `${voiceSize(m.bytes)} on your Mac` : m.progress !== undefined ? `Getting it on your Mac · ${Math.round(m.progress * 100)}%` : (m.error ?? `${voiceSize(m.bytes)} · tap to get it on your Mac now`)}
                        onPress={m.ready || m.progress !== undefined ? undefined : () => (haptic.tap(), void store.call<VoiceMacView>(calls.voicePrepare(m.model), { queue: false }).then(setMac, () => {}))}
                        chevron={false}
                      />
                    ))
                  ))}
                </Card>
              </View>
            ) : null}
          </Animated.View>
        ) : null}
      </ScrollView>
      <Options visible={langSheet} onClose={() => setLangSheet(false)} title="The language you speak" options={languageOptions} />
    </Screen>
  );
}
