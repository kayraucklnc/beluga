/**
 * How often each chat row was drawn, for the end-to-end tests that check a streamed event only
 * redraws the card it's about (KLD-48). Off unless a test seeds `window.__BELUGA_RENDERS__ = {}`
 * before the page loads; then each row adds one under its key ("card:<id>", "step:<id>").
 */

declare global {
  interface Window {
    __BELUGA_RENDERS__?: Record<string, number>;
  }
}

export function countRender(key: string): void {
  const counts = typeof window === 'undefined' ? undefined : window.__BELUGA_RENDERS__;
  if (counts) counts[key] = (counts[key] ?? 0) + 1;
}
