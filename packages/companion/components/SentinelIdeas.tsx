import { router } from 'expo-router';
import { Activity, Bot, Gauge, GitMerge, GitPullRequest, type LucideIcon, ListTodo, Sparkles, TriangleAlert, Wrench } from 'lucide-react-native';
import { useState } from 'react';
import { ScrollView, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { calls } from '../lib/link/calls';
import type { Topic } from '../lib/link/protocol';
import { store } from '../lib/store';
import { color, radius } from '../lib/theme';
import { convHref } from './Conv';
import { Button, Card, IconBadge, T, type Tone, toneBg, toneInk } from './ui';

/**
 * What Sentinel can do, when nothing watches yet (BLG-334), as on the Mac's first visit: a few
 * scenes to swipe through (a site down at night fixed by morning, a board, a failing test fixed,
 * a pull request read), one line each, and Set This Up, which asks the Sentinel chat. The
 * first idea below them has Claude look at your projects and suggest.
 */

interface Idea {
  readonly id: string;
  readonly Icon: LucideIcon;
  readonly tone: Tone;
  readonly line: string;
  readonly prompt: string;
  readonly scene: () => React.ReactNode;
}

const Mini = ({ label, value, change }: { label: string; value: string; change: string }) => (
  <View style={{ flex: 1, padding: 10, borderRadius: radius.s, backgroundColor: color.card, gap: 2 }}>
    <T v="caption" numberOfLines={1}>
      {label}
    </T>
    <T v="heading" numberOfLines={1}>
      {value}
    </T>
    <T v="caption" c={toneInk('mint')} numberOfLines={1}>
      {change}
    </T>
  </View>
);

const Step = ({ Icon, tone, title }: { Icon: LucideIcon; tone: Tone; title: string }) => (
  <View style={{ flex: 1, alignItems: 'center', gap: 6, padding: 10, borderRadius: radius.s, backgroundColor: toneBg(tone) }}>
    <Icon color={toneInk(tone)} size={16} strokeWidth={1.9} />
    <T v="caption" c={color.text} numberOfLines={2} style={{ textAlign: 'center', fontWeight: '600' }}>
      {title}
    </T>
  </View>
);

const IDEAS: readonly Idea[] = [
  {
    id: 'sleep',
    Icon: Activity,
    tone: 'rose',
    line: 'Your site goes down at 3 a.m.; by morning a fix waits for your merge',
    prompt: 'Watch my website every 5 minutes. When it stops answering, have Claude find out why on its own, open a task for it, fix it in a new worktree and open a pull request for me to merge, and tell me when it’s back.',
    scene: () => (
      <View style={{ gap: 8 }}>
        <T v="caption" style={{ textAlign: 'center' }}>
          3:12 at night · example.com stopped answering
        </T>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <Step Icon={Activity} tone="rose" title="Spotted it" />
          <Step Icon={Bot} tone="peach" title="Claude looked" />
          <Step Icon={ListTodo} tone="sky" title="Opened a task" />
          <Step Icon={GitMerge} tone="mint" title="Ready to merge" />
        </View>
      </View>
    ),
  },
  {
    id: 'board',
    Icon: Gauge,
    tone: 'sky',
    line: 'Your numbers on one board, and on your Mac’s desktop as widgets',
    prompt: 'Look at my projects and put the numbers that matter on a board: sales, sign-ups, how fast the site answers, open pull requests. Set up what keeps them fresh every morning.',
    scene: () => (
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Mini label="Revenue" value="$3,412" change="+7.3%" />
        <Mini label="Sign-ups" value="35" change="+21%" />
      </View>
    ),
  },
  {
    id: 'fix',
    Icon: Wrench,
    tone: 'peach',
    line: 'When the tests break, Claude fixes them and asks you to merge',
    prompt: 'When the tests fail on GitHub for one of my projects, have Claude find out why, fix it in a new worktree and open a pull request for me to merge.',
    scene: () => (
      <View style={{ flexDirection: 'row', gap: 6 }}>
        <Step Icon={TriangleAlert} tone="rose" title="Tests failed" />
        <Step Icon={Wrench} tone="peach" title="Claude fixed it" />
        <Step Icon={GitMerge} tone="mint" title="Ready to merge" />
      </View>
    ),
  },
  {
    id: 'review',
    Icon: GitPullRequest,
    tone: 'mint',
    line: 'Every pull request read before you get to it',
    prompt: 'When a pull request opens in one of my projects, have Claude read the change and tell me what to look at, in a few lines.',
    scene: () => (
      <View style={{ padding: 10, borderRadius: radius.m, borderTopLeftRadius: 4, backgroundColor: toneBg('peach') }}>
        <T v="caption" c={color.text}>
          Looks good. One thing: a retried webhook can refund twice. Check line 48.
        </T>
      </View>
    ),
  },
];

const SUGGEST = 'I’m new to Sentinel. Look at my projects and what they use, and suggest three watchers that would help me, each in one plain line. Set them up, with a board for their numbers, when I say yes.';

export function SentinelIdeas({ chat }: { chat?: Topic | undefined }) {
  const { width } = useWindowDimensions();
  const page = width - 32;
  const [at, setAt] = useState(0);
  const ask = (text: string): void => {
    if (!chat) return;
    void store.call(calls.send(chat, text)).then(() => router.push(convHref(chat) as never));
  };
  return (
    <View style={{ gap: 12 }}>
      <View style={{ paddingHorizontal: 20, gap: 4 }}>
        <T v="title">Let Claude keep an eye on things</T>
        <T v="callout">Say what you want; nothing runs until you turn it on.</T>
      </View>
      <ScrollView
        horizontal
        pagingEnabled={false}
        snapToInterval={page + 10}
        decelerationRate="fast"
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}
        onScroll={(e) => setAt(Math.round(e.nativeEvent.contentOffset.x / (page + 10)))}
        scrollEventThrottle={32}
        accessibilityLabel="What Sentinel can do"
      >
        {IDEAS.map((x) => (
          <Card key={x.id} style={{ width: page, padding: 16, gap: 14 }}>
            <View style={{ minHeight: 86, justifyContent: 'center', padding: 12, borderRadius: radius.m, backgroundColor: color.sunken }}>{x.scene()}</View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <IconBadge Icon={x.Icon} tone={x.tone} size={30} />
              <T v="body" c={color.text} style={{ flex: 1, fontWeight: '600' }} numberOfLines={2}>
                {x.line}
              </T>
            </View>
            {chat ? <Button label="Set This Up" onPress={() => ask(x.prompt)} /> : null}
          </Card>
        ))}
      </ScrollView>
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 6 }} accessibilityElementsHidden>
        {IDEAS.map((x, i) => (
          <Animated.View key={x.id} entering={FadeIn} style={{ width: i === at ? 22 : 8, height: 6, borderRadius: 3, backgroundColor: i === at ? color.text3 : color.hairline }} />
        ))}
      </View>
      {chat ? (
        <View style={{ paddingHorizontal: 16 }}>
          <Button quiet Icon={Sparkles} label="Suggest Some for Me" onPress={() => ask(SUGGEST)} />
        </View>
      ) : null}
    </View>
  );
}
