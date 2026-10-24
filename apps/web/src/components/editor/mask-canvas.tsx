'use client';

import { useEffect, useRef } from 'react';
import type { EditMask } from '@framecraft/shared';

export type MaskTool = 'none' | 'rect' | 'ellipse' | 'brush' | 'erase' | 'lasso' | 'pin';
export const EMPTY_MASK: EditMask = { rects: [], polygons: [], strokes: [], feather: 0.015, invert: false };

/**
 * Selection layer over the video: rectangle, ellipse, brush, eraser, lasso and comment pins.
 * Coordinates are fractions of the frame; drawn in the same order the server rasterises them
 * (rectangles, polygons, strokes), so what you see is what gets edited.
 */
export function MaskCanvas({ mask, tool, brush, subtract, onChange, onPin, pins }: { mask: EditMask; tool: MaskTool; brush: number; subtract: boolean; onChange: (m: EditMask) => void; onPin?: (x: number, y: number) => void; pins?: { x: number; y: number; label: string }[] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const draft = useRef<{ kind: MaskTool; start: [number, number]; points: [number, number][] } | null>(null);

  const draw = () => {
    const c = canvas.current;
    if (!c) return;
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(r.width * dpr)) {
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
    }
    const g = c.getContext('2d')!;
    const W = c.width;
    const H = c.height;
    g.clearRect(0, 0, W, H);
    // Selection is painted on an offscreen layer, then tinted, so subtract really cuts holes.
    const layer = document.createElement('canvas');
    layer.width = W;
    layer.height = H;
    const l = layer.getContext('2d')!;
    const mode = (sub: boolean) => (l.globalCompositeOperation = sub ? 'destination-out' : 'source-over');
    l.fillStyle = '#fff';
    l.strokeStyle = '#fff';
    l.lineCap = 'round';
    l.lineJoin = 'round';
    for (const rc of mask.rects) {
      mode(rc.subtract);
      l.beginPath();
      if (rc.ellipse) l.ellipse((rc.x + rc.w / 2) * W, (rc.y + rc.h / 2) * H, (rc.w / 2) * W, (rc.h / 2) * H, 0, 0, Math.PI * 2);
      else l.rect(rc.x * W, rc.y * H, rc.w * W, rc.h * H);
      l.fill();
    }
    for (const p of mask.polygons) {
      mode(p.subtract);
      l.beginPath();
      p.points.forEach(([x, y], i) => (i ? l.lineTo(x * W, y * H) : l.moveTo(x * W, y * H)));
      l.closePath();
      l.fill();
    }
    for (const s of mask.strokes) {
      mode(s.subtract);
      l.lineWidth = s.radius * 2 * W;
      l.beginPath();
      s.points.forEach(([x, y], i) => (i ? l.lineTo(x * W, y * H) : l.moveTo(x * W, y * H)));
      if (s.points.length === 1) l.lineTo(s.points[0]![0] * W + 0.1, s.points[0]![1] * H);
      l.stroke();
    }
    l.globalCompositeOperation = 'source-in';
    l.fillStyle = 'rgba(139,124,246,0.42)';
    l.fillRect(0, 0, W, H);
    if (mask.invert) {
      g.fillStyle = 'rgba(139,124,246,0.42)';
      g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = 'destination-out';
    }
    g.drawImage(layer, 0, 0);
    g.globalCompositeOperation = 'source-over';
    // Draft outline.
    const d = draft.current;
    if (d) {
      g.strokeStyle = '#c4b5fd';
      g.lineWidth = 1.5 * dpr;
      g.setLineDash([6 * dpr, 4 * dpr]);
      g.beginPath();
      if (d.kind === 'rect' || d.kind === 'ellipse') {
        const [x0, y0] = d.start;
        const [x1, y1] = d.points.at(-1) ?? d.start;
        if (d.kind === 'ellipse') g.ellipse(((x0 + x1) / 2) * W, ((y0 + y1) / 2) * H, (Math.abs(x1 - x0) / 2) * W, (Math.abs(y1 - y0) / 2) * H, 0, 0, Math.PI * 2);
        else g.rect(Math.min(x0, x1) * W, Math.min(y0, y1) * H, Math.abs(x1 - x0) * W, Math.abs(y1 - y0) * H);
      } else d.points.forEach(([x, y], i) => (i ? g.lineTo(x * W, y * H) : g.moveTo(x * W, y * H)));
      g.stroke();
      g.setLineDash([]);
    }
  };

  useEffect(draw);
  useEffect(() => {
    const ro = new ResizeObserver(() => draw());
    if (canvas.current) ro.observe(canvas.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const at = (e: React.PointerEvent): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  const active = tool !== 'none';

  return (
    <div className="absolute inset-0" style={{ pointerEvents: active ? 'auto' : 'none', cursor: active ? 'crosshair' : 'default' }}>
      <canvas
        ref={canvas}
        className="size-full touch-none"
        onPointerDown={(e) => {
          if (!active) return;
          const p = at(e);
          if (tool === 'pin') {
            onPin?.(p[0], p[1]);
            return;
          }
          e.currentTarget.setPointerCapture(e.pointerId);
          draft.current = { kind: tool, start: p, points: [p] };
          draw();
        }}
        onPointerMove={(e) => {
          const d = draft.current;
          if (!d) return;
          const p = at(e);
          if (d.kind === 'rect' || d.kind === 'ellipse') d.points = [p];
          else d.points.push(p);
          draw();
        }}
        onPointerUp={() => {
          const d = draft.current;
          draft.current = null;
          if (!d) return;
          const sub = subtract || d.kind === 'erase';
          const next: EditMask = { ...mask, rects: [...mask.rects], polygons: [...mask.polygons], strokes: [...mask.strokes] };
          if (d.kind === 'rect' || d.kind === 'ellipse') {
            const [x0, y0] = d.start;
            const [x1, y1] = d.points.at(-1) ?? d.start;
            if (Math.abs(x1 - x0) > 0.01 && Math.abs(y1 - y0) > 0.01) next.rects.push({ x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0), ellipse: d.kind === 'ellipse', subtract: sub });
          } else if (d.kind === 'lasso') {
            if (d.points.length >= 3) next.polygons.push({ points: d.points.filter((_, i) => i % 2 === 0 || i === d.points.length - 1).slice(0, 400), subtract: sub });
          } else {
            next.strokes.push({ points: d.points.filter((_, i) => i % 2 === 0).slice(0, 2000), radius: brush, subtract: sub });
          }
          onChange(next);
        }}
      />
      {pins?.map((p, i) => (
        <span key={i} title={p.label} className="pointer-events-none absolute -translate-x-1/2 -translate-y-full" style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}>
          <span className="grid size-6 place-items-center rounded-full rounded-bl-none bg-signal-amber text-[10px] font-bold text-black shadow">{i + 1}</span>
        </span>
      ))}
    </div>
  );
}
