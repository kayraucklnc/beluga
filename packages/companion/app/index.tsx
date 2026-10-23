import { Redirect } from 'expo-router';
import { View } from 'react-native';
import { useLink } from '../lib/hooks';
import { color } from '../lib/theme';

/** Paired (or in the demo): Home. Otherwise: pair with your Mac. */
export default function Index() {
  const link = useLink();
  if (!link.ready) return <View style={{ flex: 1, backgroundColor: color.bg }} />;
  return <Redirect href={link.mode ? '/(tabs)' : '/pair'} />;
}
