/*
 * Finds click-selected objects again on video frames off the main thread (the preview stays smooth
 * while playing). Same shared function as the export, so what is previewed is what is exported.
 */
import { adaptedMaskAt, maskOutlines, type ObjectEdit } from '@framecraft/shared';

export type AdaptRequest = {
  id: number;
  slot: number;
  key: string;
  t: number;
  obj: Pick<ObjectEdit, 'mask' | 'adapt'>;
  frame: { data: Uint8ClampedArray; width: number; height: number };
};

const post = (self as unknown as { postMessage: (m: unknown, transfer: Transferable[]) => void }).postMessage.bind(self);

self.onmessage = (e: MessageEvent<AdaptRequest>) => {
  const { id, slot, key, t, obj, frame } = e.data;
  let shape: ReturnType<typeof adaptedMaskAt> = null;
  let outline: [number, number][][] = [];
  try {
    shape = adaptedMaskAt(obj, frame, t);
    // Its outline too (normalised source coordinates), for the dashed selection line.
    if (shape) {
      const a = shape;
      outline = maskOutlines(a.mask, a.width, a.height).map((poly) => poly.map(([x, y]) => [(a.x0 + x) / a.frameWidth, (a.y0 + y) / a.frameHeight] as [number, number]));
    }
  } catch {
    shape = null;
  }
  post({ id, slot, key, t, shape, outline }, shape ? [shape.mask.buffer] : []);
};
