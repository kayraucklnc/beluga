import { createContext, useContext } from 'react';

/** True inside a stage that shows an earlier plan: its parts hide every edit, start, pass and menu that changes it. */
export const PlanReadOnly = createContext(false);

export const useReadOnly = (): boolean => useContext(PlanReadOnly);
