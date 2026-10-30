'use client';

import { memo, useContext } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { GraphCtx } from './nodes';

export type StoryEdgeData = { from: string | null; to: string | null; planned: boolean; title?: string; /** Your own clip before the gap (it becomes a shot when asked about). */ fromClip?: string | null };

/**
 * The movie's order, A → B. Its "+" asks the AI Director about the moment between the two shots:
 * insert a shot, a transition, a reaction or establishing shot, continue the action, match the light.
 */
export const StoryEdge = memo(function StoryEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, selected, data }: EdgeProps<Edge<StoryEdgeData>>) {
  const g = useContext(GraphCtx)!;
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const asking = g.ask?.key === id;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{ stroke: data?.planned ? 'rgba(167,155,250,0.55)' : '#7969f7', strokeWidth: selected || asking ? 3 : 2, strokeDasharray: data?.planned ? '6 6' : undefined }} />
      <EdgeLabelRenderer>
        <button
          type="button"
          className={cn('nodrag nopan absolute grid size-6 place-items-center rounded-full border shadow-lg transition', asking ? 'border-iris-300 bg-iris-500 text-white' : 'border-iris-400/60 bg-ink-900 text-iris-200 opacity-80 hover:scale-110 hover:bg-iris-500 hover:text-white hover:opacity-100')}
          style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`, pointerEvents: 'all' }}
          aria-label="Ask AI about the moment between these shots"
          title="Insert a shot, a transition or a reaction here"
          onClick={(e) => {
            e.stopPropagation();
            if (asking) return g.setAsk(null);
            if (!data?.from && data?.fromClip) return g.askEdgeFromClip(data.fromClip, data.to ?? null, id, { x: lx, y: ly }, data.title);
            g.setAsk({ key: id, scope: { kind: 'edge', fromShotId: data?.from ?? null, toShotId: data?.to ?? null }, flow: { x: lx, y: ly }, title: data?.title });
          }}
        >
          <Plus className="size-3.5" />
        </button>
      </EdgeLabelRenderer>
    </>
  );
});
