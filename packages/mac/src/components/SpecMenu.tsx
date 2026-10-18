import * as Context from '@radix-ui/react-context-menu';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import { type MenuKind, menuSpec } from '@klaud/ui/menus.js';
import { useActions } from '../lib/actions.js';
import { useKlaud } from '../lib/klaud.js';
import s from './SpecMenu.module.css';

/**
 * A menu built from the same spec as the terminal UI's (projectMenu, personMenu…): the same
 * options, the same ids, the same actions when picked. "Close" isn't needed here.
 */
function useItems(menu: MenuKind) {
  const { client } = useKlaud();
  const spec = menuSpec(client.store.getState(), menu);
  return (spec?.options ?? []).map((o, index) => ({ ...o, index })).filter((o) => o.id !== 'close');
}

const isDanger = (id: string): boolean => /delete|remove|leave|revoke|stop|hide/.test(id);

function Items({ menu, Item, Separator, extra = [] }: { menu: MenuKind; Item: typeof Dropdown.Item; Separator: typeof Dropdown.Separator; extra?: readonly ActionItem[] }) {
  const actions = useActions();
  const items = useItems(menu);
  return (
    <>
      {extra.map((it) => (
        <Item key={it.label} className={s.item} disabled={it.disabled} onSelect={it.onSelect}>
          <span className={s.label}>{it.label}</span>
          {it.hint ? <span className={s.hint}>{it.hint}</span> : null}
        </Item>
      ))}
      {extra.length && items.length ? <Separator className={s.separator} /> : null}
      {items.map((o, i) => {
        const separate = i > 0 && isDanger(o.id) && !isDanger(items[i - 1]!.id);
        return (
          <div key={o.id}>
            {separate ? <Separator className={s.separator} /> : null}
            <Item className={`${s.item} ${isDanger(o.id) ? s.danger : ''}`} onSelect={() => actions.pick(menu, o.index)}>
              <span className={s.label}>{o.label}</span>
              {o.hint && o.hint !== 'Esc' ? <span className={s.hint}>{o.hint}</span> : null}
            </Item>
          </div>
        );
      })}
    </>
  );
}

/** A dropdown from a button (the ⋯ on a project). Built when opened, so it's always current. */
export function SpecDropdown({ menu, children, align = 'start', extra }: { menu: MenuKind; children: ReactNode; align?: 'start' | 'end'; extra?: readonly ActionItem[] }) {
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>{children}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={s.menu} align={align} sideOffset={4} collisionPadding={8}>
          <Items menu={menu} Item={Dropdown.Item} Separator={Dropdown.Separator} {...(extra ? { extra } : {})} />
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** A right-click menu on anything (a project row, a person). */
export function SpecContext({ menu, children, extra }: { menu: MenuKind | undefined; children: ReactNode; extra?: readonly ActionItem[] }) {
  if (!menu) return <>{children}</>;
  return (
    <Context.Root modal={false}>
      <Context.Trigger asChild>{children}</Context.Trigger>
      <Context.Portal>
        <Context.Content className={s.menu} collisionPadding={8}>
          <Items menu={menu} Item={Context.Item as unknown as typeof Dropdown.Item} Separator={Context.Separator as unknown as typeof Dropdown.Separator} {...(extra ? { extra } : {})} />
        </Context.Content>
      </Context.Portal>
    </Context.Root>
  );
}

/** A plain menu of actions (not from a spec): the workspace's ⋯ and its right-click menu. */
export interface ActionItem {
  readonly label: string;
  readonly hint?: string;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly onSelect: () => void;
}

export function ActionsContext({ items, children }: { items: readonly ActionItem[]; children: ReactNode }) {
  return (
    <Context.Root modal={false}>
      <Context.Trigger asChild>{children}</Context.Trigger>
      <Context.Portal>
        <Context.Content className={s.menu} collisionPadding={8}>
          {items.map((it, i) => (
            <div key={it.label}>
              {it.danger && i > 0 && !items[i - 1]!.danger ? <Context.Separator className={s.separator} /> : null}
              <Context.Item className={`${s.item} ${it.danger ? s.danger : ''}`} disabled={it.disabled} onSelect={it.onSelect}>
                <span className={s.label}>{it.label}</span>
                {it.hint ? <span className={s.hint}>{it.hint}</span> : null}
              </Context.Item>
            </div>
          ))}
        </Context.Content>
      </Context.Portal>
    </Context.Root>
  );
}

export function ActionsDropdown({ items, children, align = 'end' }: { items: readonly ActionItem[]; children: ReactNode; align?: 'start' | 'end' }) {
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>{children}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={s.menu} align={align} sideOffset={4} collisionPadding={8}>
          {items.map((it, i) => (
            <div key={it.label}>
              {it.danger && i > 0 && !items[i - 1]!.danger ? <Dropdown.Separator className={s.separator} /> : null}
              <Dropdown.Item className={`${s.item} ${it.danger ? s.danger : ''}`} disabled={it.disabled} onSelect={it.onSelect}>
                <span className={s.label}>{it.label}</span>
                {it.hint ? <span className={s.hint}>{it.hint}</span> : null}
              </Dropdown.Item>
            </div>
          ))}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
