import { useCurrencyChoice } from '../lib/earnings.js';
import { Group, Row, Select } from './settings-controls.js';

/** "Show earnings in": the one currency every earnings total is added up in. */
export function CurrencySelect({ id, size, className }: { id?: string; size?: 'regular' | 'small'; className?: string }) {
  const choice = useCurrencyChoice();
  return <Select id={id} className={className} label="Show earnings in" value={choice.value} options={choice.options} onChange={choice.onChange} size={size} searchPlaceholder="Search currencies" />;
}

/** Settings › General › Earnings. */
export function EarningsSettings() {
  return (
    <Group title="Earnings">
      <Row label="Show earnings in" detail="Every total from Stripe, in the sidebar and the Usage view. Other currencies are converted at the European Central Bank’s daily rates.">
        <CurrencySelect />
      </Row>
    </Group>
  );
}
