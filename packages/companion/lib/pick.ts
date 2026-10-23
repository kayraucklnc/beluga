import * as ImagePicker from 'expo-image-picker';
import { store } from './store';

/** A photo from the phone, as base64 JPEG (scaled and compressed: it travels over the link). */
export async function pickPhoto(): Promise<{ name: string; mime: string; b64: string; uri: string } | undefined> {
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.6, base64: true, allowsMultipleSelection: false, exif: false });
  const a = r.canceled ? undefined : r.assets[0];
  if (!a?.base64) return undefined;
  const name = a.fileName ?? `photo-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jpg`;
  return { name, mime: a.mimeType ?? 'image/jpeg', b64: a.base64.replace(/^data:[^,]+,/, ''), uri: a.uri };
}

/** Send a picked photo to the Mac (`put`): its `up:` ref, to name in companion.ask / companion.post. */
export const upload = (photo: { name: string; mime: string; b64: string }): Promise<string> => store.put(photo.name, photo.mime, photo.b64);
