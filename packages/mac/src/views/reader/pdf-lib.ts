import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import worker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

/**
 * PDF.js, in its own chunk (the first PDF you open loads it). The legacy build: the app's web view
 * can be as old as Safari 16 (macOS 12), which the modern build no longer supports.
 */

GlobalWorkerOptions.workerSrc = worker;

export type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Open a PDF from its bytes; `close` lets it (and its worker's copy) go. */
export async function openPdf(data: Uint8Array): Promise<{ doc: PDFDocumentProxy; close: () => void }> {
  // Decoders, fonts and character maps a PDF may need, next to the app (see vite.config.ts).
  const base = new URL(`${import.meta.env.BASE_URL}pdfjs/`, window.location.href).href;
  const task = getDocument({ data, wasmUrl: `${base}wasm/`, standardFontDataUrl: `${base}standard_fonts/`, cMapUrl: `${base}cmaps/` });
  return { doc: await task.promise, close: () => void task.destroy() };
}
