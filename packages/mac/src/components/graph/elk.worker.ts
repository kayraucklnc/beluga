/**
 * ELK in its own thread: its worker script answers layout.ts (through elkjs's own protocol), so a
 * big graph never holds up the window.
 */
import 'elkjs/lib/elk-worker.min.js';
