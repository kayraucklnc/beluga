import type { ActionItem } from '../components/SpecMenu.js';
import { type UiPrefs, getPrefs, setPrefs } from '../lib/prefs.js';

/**
 * A plan is one row in the sidebar; for those who want the detail, its tasks' chats can show
 * under it too (per plan, off by default). Unread, the bell and Overview keep it as one either way.
 */

const showsTaskChats = (planId: string, prefs = getPrefs()): boolean => prefs.planTaskChats.includes(planId);

function setShowsTaskChats(planId: string, on: boolean): void {
  const rest = getPrefs().planTaskChats.filter((id) => id !== planId);
  setPrefs({ planTaskChats: on ? [...rest, planId] : rest });
}

/** The ⋯ item (the plan's row and its page; they pass usePrefs() so its check stays true). */
export const taskChatsItem = (planId: string, prefs: UiPrefs): ActionItem => {
  const on = showsTaskChats(planId, prefs);
  return { label: 'Show Task Chats in the Sidebar', checked: on, onSelect: () => setShowsTaskChats(planId, !on) };
};
