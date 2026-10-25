import { z } from 'zod';
import { motionTrackSchema } from './layers';

/** Normalised (0–1) spatial selection. Brush strokes are polylines with a radius. */
export const editMaskSchema = z.object({
  rects: z.array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1), ellipse: z.boolean().default(false), subtract: z.boolean().default(false) })).max(20).default([]),
  polygons: z.array(z.object({ points: z.array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])).min(3).max(400), subtract: z.boolean().default(false) })).max(20).default([]),
  strokes: z.array(z.object({ points: z.array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])).min(1).max(2000), radius: z.number().min(0.002).max(0.3), subtract: z.boolean().default(false) })).max(50).default([]),
  /** Soft edge as a fraction of the frame width. */
  feather: z.number().min(0).max(0.1).default(0.015),
  invert: z.boolean().default(false),
  /** Moves with a tracked object (source-time offsets from where the selection was drawn). */
  track: motionTrackSchema.optional(),
});
export type EditMask = z.infer<typeof editMaskSchema>;
