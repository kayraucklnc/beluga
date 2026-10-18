import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

/** A QR code of `text`, drawn as one SVG path (dark modules on white, with the quiet zone around). */
export function QrCode({ text, size = 112, label }: { text: string; size?: number; label: string }) {
  const { path, count } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    return { path: d, count: n };
  }, [text]);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${count} ${count}`} shapeRendering="crispEdges" role="img" aria-label={label}>
      <path d={path} fill="#111" />
    </svg>
  );
}
