import { Icon } from '../components/Icon.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { Row } from '../layout/sidebar-parts.js';

/**
 * "Your phone" in the sidebar, just under "Your Mac" (BLG-171). Shown only when a phone is paired —
 * nothing clutters the Mac when there's no phone. Opens the phone page (the live mirror and what
 * Claude's done on it). A green dot while a phone is linked.
 */
export function PhoneNav() {
  const actions = useActions();
  const phone = useApp((st) => {
    const android = st.companion.devices.filter((d) => d.platform !== 'ios');
    if (!android.length) return undefined;
    const linked = android.some((d) => d.linked);
    const usable = android.some((d) => d.control && d.control.routes.length > 0);
    return { name: android.length === 1 ? android[0]!.name : `${android.length} phones`, linked, usable };
    // A new object each time: without sameDeep the window re-renders forever and goes blank (1.1.0).
  }, sameDeep);
  const selected = useApp((st) => st.view.kind === 'phone');
  if (!phone) return null;
  return (
    <Row
      icon={<Icon name="phone" size={14} />}
      label="Your phone"
      detail={phone.usable ? 'Ask Claude to do things here, or drive it yourself' : 'Set it up in Settings › Phone to let Claude use it'}
      selected={selected}
      onClick={() => actions.run({ type: 'view', view: { kind: 'phone' } })}
      trailing={phone.linked ? <span aria-label="linked" style={{ width: 7, height: 7, borderRadius: 7, background: 'var(--ok, #58c08b)' }} /> : null}
    />
  );
}
