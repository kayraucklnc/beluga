// 1003 = report pointer movement too (for hover feedback), 1006 = SGR coordinates.
export const MOUSE_ON = '\x1b[?1000h\x1b[?1003h\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1003l\x1b[?1000l\x1b[?1006l';
