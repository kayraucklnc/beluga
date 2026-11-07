import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { CirclePause, CirclePlay, Clock, Play } from 'lucide-react-native';
import { calls } from '../lib/link/calls';
import type { ConvView, ScheduleRowView, TurnView } from '../lib/link/protocol';
import { store } from '../lib/store';
import { color } from '../lib/theme';
import { sentLine } from '../../../src/shared/schedule/words';
import { Sheet } from './Sheet';
import { Card, IconBadge, Press, T, type Tone } from './ui';

/**
 * A chat's schedules (BLG-97): the list under the conversation's •••, and the quiet line a run
 * leaves in the chat. Your own can run now, pause and resume; making and editing stay the Mac's. In
 * a chat someone shared with you, the list only reads: it runs on their computer.
 */

const TONES: Readonly<Record<ScheduleRowView['status'], Tone>> = { never: 'plain', waiting: 'sky', running: 'peach', ok: 'mint', failed: 'rose', interrupted: 'butter', paused: 'butter' };
const time = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function SchedulesSheet({ schedules, visible, onClose }: { readonly schedules: ConvView['schedules']; readonly visible: boolean; readonly onClose: () => void }) {
  const owner = schedules?.owner;
  return (
    <Sheet
      visible={visible}
      onDismiss={onClose}
      header={
        <View style={{ paddingHorizontal: 20, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <IconBadge Icon={Clock} tone="mint" size={32} />
          <View style={{ flex: 1 }}>
            <T v="title" style={{ fontSize: 20 }}>
              Schedules
            </T>
            <T v="caption">{owner ? `Runs on ${owner}’s computer` : 'Runs on your Mac, in this chat'}</T>
          </View>
        </View>
      }
    >
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 20, gap: 10 }}>
        {schedules?.items.map((s) => <ScheduleRow key={s.id} s={s} readOnly={Boolean(owner)} />)}
      </ScrollView>
    </Sheet>
  );
}

function ScheduleRow({ s, readOnly }: { readonly s: ScheduleRowView; readonly readOnly: boolean }) {
  const act = (call: ReturnType<typeof calls.scheduleRun>): void => void store.call(call, { queue: false }).catch((e: Error) => store.toast({ text: e.message, tone: 'error' }));
  return (
    <Card style={{ padding: 14, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <IconBadge Icon={Clock} tone={TONES[s.status]} size={30} />
        <View style={{ flex: 1 }}>
          <T v="callout" c={color.text} numberOfLines={1} style={{ fontWeight: '700' }}>
            {s.title}
          </T>
          <T v="caption" numberOfLines={2}>
            {sentLine(s, Date.now())}
          </T>
        </View>
      </View>
      <T v="caption" numberOfLines={3}>
        {s.prompt}
      </T>
      {s.problem ? (
        <T v="caption" c={color.error}>
          {s.problem}
        </T>
      ) : null}
      {readOnly ? null : (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <RowButton Icon={Play} label="Run now" disabled={s.status === 'running'} onPress={() => act(calls.scheduleRun(s.id, s.title))} />
          {s.enabled ? <RowButton Icon={CirclePause} label="Pause" onPress={() => act(calls.scheduleSetOn(s.id, false, s.title))} /> : <RowButton Icon={CirclePlay} label="Resume" onPress={() => act(calls.scheduleSetOn(s.id, true, s.title))} />}
        </View>
      )}
    </Card>
  );
}

function RowButton({ Icon, label, disabled, onPress }: { readonly Icon: typeof Play; readonly label: string; readonly disabled?: boolean; readonly onPress: () => void }) {
  return (
    <Press onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 32, borderRadius: 16, backgroundColor: color.sunken, opacity: disabled ? 0.5 : 1 }}>
      <Icon color={color.text2} size={14} />
      <T v="caption" c={color.text} style={{ fontWeight: '600' }}>
        {label}
      </T>
    </Press>
  );
}

/** Where a scheduled run begins: one quiet line in the chat, not a message. A tap shows what it asks. */
export function ScheduleRunLine({ run }: { readonly run: NonNullable<TurnView['scheduled']> }) {
  const [open, setOpen] = useState(false);
  const words = [run.title, ...(run.paused ? ['paused'] : [`due ${time(run.due)}`]), ...run.extras].join(' · ');
  const ink = run.paused ? color.error : color.text3;
  return (
    <Press onPress={() => setOpen(!open)} haptics={false} scaleTo={1} accessibilityRole="button" accessibilityLabel={`Schedule: ${words}`} style={{ alignItems: 'center', gap: 4, paddingHorizontal: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Clock color={ink} size={12} />
        <T v="caption" c={ink} style={{ flexShrink: 1, textAlign: 'center' }}>
          {words}
        </T>
      </View>
      {open ? (
        <T v="caption" style={{ textAlign: 'center' }}>
          {run.prompt}
        </T>
      ) : null}
    </Press>
  );
}
