import { useCallback } from 'react';
import { type MenuKind, menuSpec } from '@beluga/ui/menus.js';
import { useActions } from '../../lib/actions.js';
import { useBeluga } from '../../lib/beluga.js';

/**
 * Pick a menu option by its id, as if you chose it from the menu's list:
 * the same option, the same action. Native sheets draw the menu their own way but act through this.
 */
export function usePick(menu: MenuKind): (id: string, confirmed?: boolean) => boolean {
  const actions = useActions();
  const { client } = useBeluga();
  return useCallback(
    (id, confirmed = true) => {
      const index = menuSpec(client.store.getState(), menu)?.options.findIndex((o) => o.id === id) ?? -1;
      if (index < 0) return false;
      actions.pick(menu, index, confirmed);
      return true;
    },
    [actions, client, menu],
  );
}

/** "3 files", "1 file". */
export const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
