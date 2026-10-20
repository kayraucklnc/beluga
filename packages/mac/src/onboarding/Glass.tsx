import { type ReactNode, type RefObject, createContext, useContext } from 'react';
import GlassSurface from '../components/reactbits/GlassSurface.js';

/**
 * React Bits' Glass Surface, set up for the welcome: liquid glass that bends the smoke behind
 * it. Chrome bends it with an SVG filter; Safari (and so the Mac app) can't, so there it reads
 * the smoke's own canvas (shared through this context) and bends that on the GPU.
 */
export const GlassBackdrop = createContext<RefObject<HTMLCanvasElement | null> | null>(null);

interface Props {
  readonly children: ReactNode;
  readonly radius: number;
  readonly className?: string;
  readonly width?: number | string;
  readonly height?: number | string;
}

export function Glass({ children, radius, className, width = 'auto', height = 'auto' }: Props) {
  const backdrop = useContext(GlassBackdrop);
  return (
    <GlassSurface
      className={className}
      width={width}
      height={height}
      borderRadius={radius}
      backdrop={backdrop}
      brightness={52}
      opacity={0.9}
      blur={14}
      backgroundOpacity={0.12}
      saturation={1.3}
      distortionScale={-120}
      displace={0.4}
    >
      {children}
    </GlassSurface>
  );
}
