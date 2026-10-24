import { ArrowRight, Check, CircleAlert, Clock, FileWarning, GitBranch, GitMerge, Info, RefreshCw, Sparkles, TriangleAlert } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, LinearTransition } from 'react-native-reanimated';
import { calls } from '../lib/link/calls';
import type { BranchView, MergeCheckView, MergeView, Topic } from '../lib/link/protocol';
import { store } from '../lib/store';
import { color } from '../lib/theme';
import { Breathe, TypingDots } from './Live';
import { Sheet } from './Sheet';
import { Button, Card, haptic, IconBadge, Pill, Press, T, type Tone, toneBg, toneInk } from './ui';

/**
 * Merging a worktree from the phone (BLG-67), the Mac's own way: the sheet shows what would merge
 * and the Mac's checks before anything happens (merging is deliberate, so this sheet is the
 * confirmation); the band in the conversation follows it live: merging, the conflicting files (by
 * name), Claude resolving them, merged.
 */

const TONE: Record<string, { Icon: typeof Check; tone: Tone }> = { ok: { Icon: Check, tone: 'mint' }, info: { Icon: Info, tone: 'sky' }, block: { Icon: TriangleAlert, tone: 'butter' } };

export function MergeSheet({ topic, visible, onClose }: { readonly topic: Topic; readonly visible: boolean; readonly onClose: () => void }) {
  const [check, setCheck] = useState<MergeCheckView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const look = () => {
    setCheck(undefined);
    setError(undefined);
    store.call<MergeCheckView>(calls.mergeCheck(topic), { queue: false }).then(
      (c) => setCheck(c),
      (e: Error) => setError(e.message),
    );
  };
  useEffect(() => {
    if (visible) look();
  }, [visible]);
  const merge = async () => {
    if (!check?.canMerge || busy) return;
    haptic.commit();
    setBusy(true);
    await store.call(calls.merge(topic), { queue: false }).catch((e: Error) => store.toast({ text: e.message, tone: 'error' }));
    setBusy(false);
    onClose();
  };
  const resolve = async () => {
    haptic.commit();
    await store.call(calls.resolve(topic), { queue: false }).catch((e: Error) => store.toast({ text: e.message, tone: 'error' }));
    onClose();
  };
  const claudeFix = check?.checks.some((c) => c.fix === 'claude');
  return (
    <Sheet
      visible={visible}
      onDismiss={onClose}
      header={
        <View style={{ paddingHorizontal: 20, paddingBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <IconBadge Icon={GitMerge} tone="lavender" size={34} />
          <T v="title" style={{ flex: 1, fontSize: 21 }}>
            Merge into {check?.into ?? 'main'}
          </T>
        </View>
      }
    >
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 12, gap: 14 }}>
        {error ? (
          <T v="callout" c={color.error}>
            Couldn’t look at this branch: {error}
          </T>
        ) : !check ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 18 }}>
            <ActivityIndicator color={color.text3} />
            <T v="callout">Checking what would merge…</T>
          </View>
        ) : (
          <Animated.View entering={FadeIn.duration(200)} style={{ gap: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Pill label={check.from} tone="lavender" />
              <ArrowRight color={color.text3} size={16} />
              <Pill label={check.into} tone="mint" />
            </View>
            {check.commits ? (
              <View style={{ gap: 4 }}>
                <T v="callout" c={color.text} style={{ fontWeight: '600' }}>
                  {check.commits} {check.commits === 1 ? 'commit' : 'commits'} · {check.files} {check.files === 1 ? 'file' : 'files'}
                </T>
                {check.subjects.map((s, i) => (
                  <T key={i} v="callout" numberOfLines={1}>
                    {s}
                  </T>
                ))}
              </View>
            ) : null}
            <View style={{ gap: 8 }}>
              {check.checks.map((c) => {
                const t = TONE[c.tone] ?? TONE.info!;
                return (
                  <View key={c.id} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                    <View style={{ width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: toneBg(t.tone) }}>
                      <t.Icon color={toneInk(t.tone)} size={13} strokeWidth={2.4} />
                    </View>
                    <T v="callout" c={color.text} style={{ flex: 1 }}>
                      {c.text}
                    </T>
                  </View>
                );
              })}
            </View>
            {check.conflicts?.length ? <Files files={check.conflicts} /> : null}
            <T v="caption">A merge commit is made in your Mac’s main folder, so its files change. Nothing is pushed.</T>
          </Animated.View>
        )}
      </ScrollView>
      <View style={{ paddingHorizontal: 20, paddingTop: 6, gap: 10 }}>
        {claudeFix ? <Button label="Ask Claude to resolve" Icon={Sparkles} onPress={() => void resolve()} /> : null}
        <Button label={busy ? 'Merging…' : (check?.confirm ?? 'Merge')} Icon={GitMerge} quiet={claudeFix} disabled={!check?.canMerge || busy} onPress={() => void merge()} />
      </View>
    </Sheet>
  );
}

/** Conflicting files, by name only. */
function Files({ files }: { readonly files: readonly string[] }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {files.slice(0, 12).map((f) => (
        <View key={f} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 28, paddingHorizontal: 10, borderRadius: 14, backgroundColor: toneBg('rose') }}>
          <FileWarning color={toneInk('rose')} size={13} />
          <T v="caption" c={toneInk('rose')} numberOfLines={1} style={{ fontWeight: '600', maxWidth: 180 }}>
            {f}
          </T>
        </View>
      ))}
      {files.length > 12 ? <T v="caption">and {files.length - 12} more</T> : null}
    </View>
  );
}

const BAND: Record<string, { tone: Tone; Icon: typeof Check; title: (m: MergeView) => string }> = {
  merging: { tone: 'lavender', Icon: GitMerge, title: () => 'Merging…' },
  conflicts: { tone: 'rose', Icon: CircleAlert, title: (m) => `${m.conflicts?.length ?? 'Some'} ${m.conflicts?.length === 1 ? 'file conflicts' : 'files conflict'}` },
  resolving: { tone: 'lavender', Icon: Sparkles, title: () => 'Claude is resolving the conflicts' },
  resolved: { tone: 'sky', Icon: Check, title: () => 'Claude is done: check it and merge' },
  merged: { tone: 'mint', Icon: Check, title: () => 'Merged' },
  blocked: { tone: 'butter', Icon: TriangleAlert, title: () => 'Not merged yet' },
};

/** Where the merge stands, in the conversation, live; each step's next action is on it. */
export function MergeBand({ topic, merge, onCheck }: { readonly topic: Topic; readonly merge: MergeView; readonly onCheck: () => void }) {
  const b = BAND[merge.phase] ?? BAND.blocked!;
  const live = merge.phase === 'merging' || merge.phase === 'resolving';
  const resolve = () => {
    haptic.commit();
    void store.call(calls.resolve(topic), { queue: false }).catch((e: Error) => store.toast({ text: e.message, tone: 'error' }));
  };
  return (
    <Animated.View key={merge.phase} entering={FadeInDown.duration(260)} layout={LinearTransition.springify()}>
      <Card tone={b.tone} style={{ padding: 14, gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Breathe on={live}>
            <View style={{ width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: color.card }}>
              <b.Icon color={toneInk(b.tone)} size={16} strokeWidth={2.3} />
            </View>
          </Breathe>
          <T v="callout" c={toneInk(b.tone)} style={{ fontWeight: '700', flex: 1 }}>
            {b.title(merge)}
          </T>
          {live ? <TypingDots tone={b.tone} /> : null}
        </View>
        {merge.why ? (
          <T v="callout" c={toneInk(b.tone)}>
            {merge.why}
          </T>
        ) : null}
        {merge.conflicts?.length && merge.phase !== 'merged' ? <Files files={merge.conflicts} /> : null}
        {merge.phase === 'conflicts' ? <Button label="Ask Claude to resolve" Icon={Sparkles} onPress={resolve} /> : null}
        {merge.phase === 'resolved' || merge.phase === 'blocked' ? (
          <Press onPress={onCheck} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', height: 34, paddingHorizontal: 14, borderRadius: 17, backgroundColor: color.card }}>
            <RefreshCw color={color.text} size={14} />
            <T v="callout" c={color.text} style={{ fontWeight: '600' }}>
              Check again
            </T>
          </Press>
        ) : null}
      </Card>
    </Animated.View>
  );
}

const BRANCH_TONE: Record<string, { tone: Tone; Icon: typeof Check }> = {
  merged: { tone: 'lavender', Icon: GitMerge },
  ok: { tone: 'mint', Icon: Check },
  error: { tone: 'rose', Icon: CircleAlert },
  warn: { tone: 'butter', Icon: TriangleAlert },
  wait: { tone: 'butter', Icon: Clock },
  info: { tone: 'sky', Icon: GitBranch },
  muted: { tone: 'plain', Icon: GitBranch },
};

/**
 * Where a worktree's branch stands, as the Mac's toolbar shows it: Merged (lavender), Ready to
 * merge, Conflicts, checks… with why, and its next step. Merging it into the main folder and
 * Claude resolving a conflict happen here; a pull request's steps are the Mac's.
 */
export function BranchBand({ topic, branch, canMerge, onMerge }: { readonly topic: Topic; readonly branch: BranchView; readonly canMerge: boolean; readonly onMerge: () => void }) {
  const t = BRANCH_TONE[branch.tone] ?? BRANCH_TONE.muted!;
  const resolve = () => {
    haptic.commit();
    void store.call(calls.resolve(topic), { queue: false }).catch((e: Error) => store.toast({ text: e.message, tone: 'error' }));
  };
  const next = branch.next;
  const here = next?.id === 'merge' && canMerge ? 'merge' : next?.id === 'merge_claude' ? 'resolve' : undefined;
  return (
    <Animated.View key={branch.kind} entering={FadeIn.duration(200)} layout={LinearTransition.springify()}>
      <Card style={{ paddingVertical: 10, paddingHorizontal: 12, gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Pill label={branch.label} tone={t.tone} Icon={t.Icon} />
          <T v="caption" numberOfLines={2} style={{ flex: 1 }}>
            {branch.detail}
          </T>
        </View>
        {here === 'merge' ? <Button label={next!.label.replace(/…$/, '')} Icon={GitMerge} quiet onPress={onMerge} /> : null}
        {here === 'resolve' ? <Button label="Ask Claude to resolve" Icon={Sparkles} onPress={resolve} /> : null}
        {next && !here ? (
          <T v="caption" c={color.text3}>
            Next, on your Mac: {next.label.replace(/…$/, '')}
            {next.claude ? ' (Claude does it)' : ''}
          </T>
        ) : null}
      </Card>
    </Animated.View>
  );
}
