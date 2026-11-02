import type { ReactNode } from 'react';
import { type StyleProp, View, type ViewStyle } from 'react-native';

/** The web build: the browser moves the page for its keyboard itself. */
export function KeyboardLift({ children, style, pointerEvents }: { readonly children: ReactNode; readonly style?: StyleProp<ViewStyle>; readonly pointerEvents?: 'box-none' | 'auto' }) {
  return (
    <View style={[{ flex: 1 }, style]} pointerEvents={pointerEvents}>
      {children}
    </View>
  );
}
