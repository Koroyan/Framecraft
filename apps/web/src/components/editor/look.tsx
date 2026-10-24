'use client';

import { cameraAt, gradeOf, isNeutralAdjust, type ClipAdjust, type ClipCamera } from '@framecraft/shared';

/*
 * Live preview of a clip's colour grade and 2D camera, using the same maths as the FFmpeg export
 * (@framecraft/shared gradeOf / cameraAt). Blur, sharpen and vignette are close approximations.
 */

/** SVG filter for a grade; reference it with `filter: url(#id)`. Renders nothing when neutral. */
export function GradeFilter({ id, adjust, displayHeight = 540 }: { id: string; adjust?: Partial<ClipAdjust>; displayHeight?: number }) {
  if (isNeutralAdjust(adjust)) return null;
  const g = gradeOf(adjust);
  const m = g.matrix;
  const matrix = [m[0], m[1], m[2], 0, 0, m[3], m[4], m[5], 0, 0, m[6], m[7], m[8], 0, 0, 0, 0, 0, 1, 0].join(' ');
  const a = -(g.sharpen * 0.25);
  return (
    <svg width="0" height="0" className="absolute" aria-hidden>
      <filter id={id} colorInterpolationFilters="sRGB">
        <feColorMatrix type="matrix" values={matrix} />
        <feComponentTransfer>
          <feFuncR type="linear" slope={g.slope} intercept={g.intercept} />
          <feFuncG type="linear" slope={g.slope} intercept={g.intercept} />
          <feFuncB type="linear" slope={g.slope} intercept={g.intercept} />
        </feComponentTransfer>
        {g.curve && (
          <feComponentTransfer>
            <feFuncR type="table" tableValues={g.curve.join(' ')} />
            <feFuncG type="table" tableValues={g.curve.join(' ')} />
            <feFuncB type="table" tableValues={g.curve.join(' ')} />
          </feComponentTransfer>
        )}
        {g.sharpen > 0 && <feConvolveMatrix order="3" kernelMatrix={`0 ${a} 0 ${a} ${1 - 4 * a} ${a} 0 ${a} 0`} preserveAlpha="true" />}
        {g.blur > 0 && <feGaussianBlur stdDeviation={(g.blur * displayHeight) / 1080} />}
      </filter>
    </svg>
  );
}

/** CSS for the camera window at clip time `t` (the frame's container must clip overflow). */
export function cameraStyle(cam: ClipCamera | undefined, t: number): React.CSSProperties {
  if (!cam?.keyframes.length) return {};
  const k = cameraAt(cam, t);
  if (k.scale === 1 && k.rotation === 0) return {};
  return { transform: `rotate(${k.rotation}deg) scale(${k.scale}) translate(${(0.5 - k.x) * 100}%, ${(0.5 - k.y) * 100}%)`, transformOrigin: '50% 50%' };
}

export function Vignette({ amount }: { amount?: number }) {
  if (!amount) return null;
  return <div className="pointer-events-none absolute inset-0" style={{ background: `radial-gradient(ellipse at center, transparent ${Math.round(70 - amount * 35)}%, rgba(0,0,0,${0.35 + amount * 0.55}) 100%)` }} />;
}
