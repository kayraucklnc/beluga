import { describe, expect, it } from 'vitest';
import { handleKey, initialUi } from '../src/ui/keymap.js';

describe('text size', () => {
  it('Option+↑ / Option+↓ (and Ctrl) change text size from anywhere', () => {
    const ctx = { hasApproval: false, hasViewer: false, overlay: false, page: 20, maxChatScroll: 0, suggestions: [], peopleCount: 1, menuSize: 0 };
    expect(handleKey(initialUi, '', { ctrl: true, upArrow: true }, ctx).effect).toEqual({ type: 'zoom', dir: 'in' });
    expect(handleKey(initialUi, '', { ctrl: true, downArrow: true }, ctx).effect).toEqual({ type: 'zoom', dir: 'out' });
    expect(handleKey(initialUi, '', { meta: true, upArrow: true }, ctx).effect).toEqual({ type: 'zoom', dir: 'in' });
  });
});
