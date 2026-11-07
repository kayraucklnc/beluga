import { Icon } from '../components/Icon.js';
import { Tip } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { chatMarks, scheduleLine } from './schedule-model.js';
import c from './schedule.module.css';

/** The small clock on a sidebar row: this chat wakes by itself. Muted when it's paused, absent otherwise. */
export function ChatScheduleMark({ channel }: { channel: string }) {
  const mark = useApp((st) => (st.prefs.chatSchedules ? chatMarks(st.schedules)[channel] : undefined));
  if (!mark) return null;
  return (
    <Tip label={`${mark.item.title}: ${scheduleLine(mark.item, Date.now())}`}>
      <span className={c.sideMark} data-schedule-mark={mark.paused ? 'paused' : 'on'}>
        <Icon name="clock" size={11} />
      </span>
    </Tip>
  );
}
