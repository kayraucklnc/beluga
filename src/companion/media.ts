/**
 * Which videos play where (BLG-100, BLG-103): pure, for the phone's player and the Mac's.
 * MP4, M4V and MOV (H.264 or HEVC) play on both platforms' players; WebM (VP8, VP9) on Android's
 * and in the Mac's web view, not on iPhone. What a player still can't open (a codec it lacks: ProRes,
 * say) shows the same fallback when it fails. Nothing is transcoded.
 */

export interface VideoFormat {
  /** ".mp4" */
  readonly ext: string;
  /** "MP4" */
  readonly label: string;
  readonly mime: string;
}

const FORMATS: Readonly<Record<string, VideoFormat>> = {
  '.mp4': { ext: '.mp4', label: 'MP4', mime: 'video/mp4' },
  '.m4v': { ext: '.m4v', label: 'M4V', mime: 'video/x-m4v' },
  '.mov': { ext: '.mov', label: 'MOV', mime: 'video/quicktime' },
  '.webm': { ext: '.webm', label: 'WebM', mime: 'video/webm' },
};

const extOf = (name: string): string => /\.[A-Za-z0-9]{1,8}$/.exec(name)?.[0]?.toLowerCase() ?? '';

/** The video format a file's name says, if it's one. */
export const videoFormat = (name: string): VideoFormat | undefined => FORMATS[extOf(name)];

export const isGif = (name: string): boolean => extOf(name) === '.gif';

export type Player = 'android' | 'ios' | 'web';

/** Undefined when it should play here; else why not, in words for the fallback. */
export function cantPlay(name: string, on: Player): string | undefined {
  const f = videoFormat(name);
  if (!f) return 'This kind of file doesn’t play here.';
  if (f.ext === '.webm' && on === 'ios') return 'iPhone can’t play WebM videos.';
  return undefined;
}

/** The path for an output under the media server's base URL: the name's extension last, which some players go by. */
export function mediaPath(ref: string, name: string): string {
  return `/${encodeURIComponent(ref)}/media${extOf(name)}`;
}
