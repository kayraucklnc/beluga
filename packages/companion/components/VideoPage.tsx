import { useEvent } from 'expo';
import { Image } from 'expo-image';
import { useFocusEffect } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Film, Play, RotateCw, X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, AppState, Platform, View } from 'react-native';
import { useFile } from '../lib/hooks';
import type { OutputView } from '../lib/link/protocol';
import { cantPlay, videoFormat } from '../lib/media';
import { store } from '../lib/store';
import { color } from '../lib/theme';
import { sizeOf } from './Outputs';
import { haptic, Press, T } from './ui';

/**
 * A video as a page of the viewer (BLG-100, BLG-103): its first frame (the Mac's thumbnail) with a
 * play mark until you tap it, so swiping past a video costs nothing. Then it streams from the link
 * worklet's loopback server (src/companion/media-stream.ts: range requests, only what the player
 * reads) and plays with the platform's own controls: play, pause, seek, full screen.
 *
 * Never on its own: no autoplay, no loop, paused when you swipe away, leave the screen or put the
 * app away. While it plays, the viewer's swipes stand aside so the controls get every touch; Done
 * gives them back. What the player can't open shows why, with Retry; nothing is transcoded.
 */
export function VideoPage({ o, active, onEngage, onRatio }: { readonly o: OutputView; readonly active: boolean; readonly onEngage: (on: boolean) => void; /** The video's shape, from its first frame. */ readonly onRatio?: (ratio: number) => void }) {
  const why = cantPlay(o.name, Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web');
  const poster = useFile(why ? undefined : o.ref, 'thumb');
  const [engaged, setEngaged] = useState(false);
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  const engage = (on: boolean): void => {
    haptic.tap();
    setEngaged(on);
    setError(undefined);
    if (!on) setUrl(undefined);
    onEngage(on);
  };

  // The URL only once you tap play (the server starts with the first video).
  useEffect(() => {
    if (!engaged || url) return;
    let alive = true;
    store.mediaUrl(o).then(
      (u) => alive && setUrl(u),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [engaged, url, attempt, o.ref]);

  // Swiped away: stop, and give the swipes back.
  useEffect(() => {
    if (!active && engaged) {
      setEngaged(false);
      setUrl(undefined);
      onEngage(false);
    }
  }, [active]);

  if (why) return <Fallback o={o} title="Can’t play this one here" detail={`${why} Open it on your Mac.`} />;
  if (!engaged) {
    return (
      <Press onPress={() => engage(true)} accessibilityLabel={`Play ${o.name}`} style={{ flex: 1, backgroundColor: color.onStageCard, borderRadius: 22, overflow: 'hidden' }}>
        {poster?.uri ? <Image
            source={{ uri: poster.uri }}
            style={{ flex: 1 }}
            contentFit="contain"
            transition={220}
            onLoad={(e) => {
              const { width, height } = e.source;
              if (width && height) onRatio?.(width / height);
            }}
          /> : <View style={{ flex: 1 }} />}
        <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <View style={{ width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center', backgroundColor: color.onStageChip }}>
            <Play color={color.onStage} fill={color.onStage} size={28} style={{ marginLeft: 4 }} />
          </View>
          {!poster?.uri ? (
            <T v="caption" c={color.onStageDim}>
              {[videoFormat(o.name)?.label, sizeOf(o.size)].filter(Boolean).join(' · ')}
            </T>
          ) : null}
        </View>
      </Press>
    );
  }
  if (error) return <Fallback o={o} title="Couldn’t play it" detail={error} retry={() => (setError(undefined), setUrl(undefined), setAttempt((a) => a + 1))} done={() => engage(false)} />;
  if (!url) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: color.stage }}>
        <ActivityIndicator color={color.onStageDim} />
      </View>
    );
  }
  return <Player key={`${url}#${attempt}`} url={url} name={o.name} onFail={(m) => setError(m)} onDone={() => engage(false)} />;
}

function Player({ url, name, onFail, onDone }: { readonly url: string; readonly name: string; readonly onFail: (message: string) => void; readonly onDone: () => void }) {
  const source = useMemo(() => ({ uri: url, contentType: 'progressive' as const }), [url]);
  const player = useVideoPlayer(source, (p) => {
    p.loop = false;
    p.play();
  });
  const { status, error } = useEvent(player, 'statusChange', { status: player.status });
  useEffect(() => {
    if (status === 'error') onFail(`${videoFormat(name)?.label ?? 'This'} video didn’t play on this phone${error?.message ? ` (${error.message.slice(0, 120)})` : ''}. Open it on your Mac.`);
  }, [status]);
  // Put away, or another screen on top: paused.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => s !== 'active' && player.pause());
    return () => sub.remove();
  }, [player]);
  useFocusEffect(useCallback(() => () => player.pause(), [player]));
  return (
    <View style={{ flex: 1, backgroundColor: '#000', borderRadius: 22, overflow: 'hidden' }}>
      <VideoView player={player} style={{ flex: 1 }} nativeControls contentFit="contain" allowsPictureInPicture={false} fullscreenOptions={{ enable: true }} />
      {status === 'loading' ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={color.onStageDim} />
        </View>
      ) : null}
      <Press onPress={onDone} accessibilityLabel="Done" style={{ position: 'absolute', top: 10, right: 10, height: 32, paddingHorizontal: 12, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: color.onStageChip }}>
        <X color={color.onStage} size={15} />
        <T v="caption" c={color.onStage} style={{ fontWeight: '600' }}>
          Done
        </T>
      </Press>
    </View>
  );
}

function Fallback({ o, title, detail, retry, done }: { readonly o: OutputView; readonly title: string; readonly detail: string; readonly retry?: () => void; readonly done?: () => void }) {
  return (
    <View style={{ flex: 1, backgroundColor: color.onStageCard, borderWidth: 1, borderColor: color.onStageLine, borderRadius: 22, padding: 22, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
      <View style={{ width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: color.onStageChip }}>
        <Film color={color.onStage} size={24} />
      </View>
      <T v="callout" c={color.onStage} style={{ fontWeight: '600', textAlign: 'center' }}>
        {title}
      </T>
      <T v="caption" c={color.onStageDim} style={{ textAlign: 'center' }}>
        {detail}
      </T>
      <T v="caption" c={color.onStageDim} numberOfLines={1} ellipsizeMode="middle">
        {[o.name, sizeOf(o.size)].filter(Boolean).join(' · ')}
      </T>
      {retry ? (
        <Press onPress={retry} accessibilityLabel="Retry" style={{ marginTop: 6, height: 42, paddingHorizontal: 20, borderRadius: 21, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: color.onStage }}>
          <RotateCw color={color.stage} size={16} />
          <T v="callout" c={color.stage} style={{ fontWeight: '700' }}>
            Retry
          </T>
        </Press>
      ) : null}
      {done ? (
        <Press onPress={done} accessibilityLabel="Back">
          <T v="caption" c={color.onStageDim}>
            Back
          </T>
        </Press>
      ) : null}
    </View>
  );
}
