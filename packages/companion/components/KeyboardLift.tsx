import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

/**
 * What sits above the keyboard: the screen's content is lifted by the keyboard's height, frame by
 * frame with the keyboard's own animation (react-native-keyboard-controller), on Android
 * (edge-to-edge, where adjustResize doesn't help) and iOS alike. Every screen with a text field
 * uses this, so no field or button ever ends up under the keyboard; sheets too (Sheet.tsx), whose
 * card sits at the bottom of a lifted, see-through layer.
 */
export function KeyboardLift({ children, style, pointerEvents }: { readonly children: ReactNode; readonly style?: StyleProp<ViewStyle>; readonly pointerEvents?: 'box-none' | 'auto' }) {
  return (
    <KeyboardAvoidingView behavior="padding" style={[{ flex: 1 }, style]} pointerEvents={pointerEvents}>
      {children}
    </KeyboardAvoidingView>
  );
}
