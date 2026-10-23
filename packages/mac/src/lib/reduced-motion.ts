/** Whether the window asks for less motion (Settings › Appearance or the system). */
export const reducedMotion = (): boolean =>
  document.documentElement.dataset.motion === 'reduce' || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
