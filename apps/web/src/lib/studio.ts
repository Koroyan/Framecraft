'use client';

import { useQuery } from '@tanstack/react-query';
import type { AiEditMode, EditMask, PlanOp } from '@framecraft/shared';
import { api } from '@/lib/api';

/* Editor studio API types and hooks (shot versions, comments, AI edits, assistant). */

export type VersionMedia = { url: string; thumbnailUrl: string | null; durationSec: number | null; isFixture: boolean };
export type ShotVersion = {
  id: string;
  shotId: string;
  number: number;
  assetId: string;
  parentVersionId: string | null;
  label: string;
  source: 'generated' | 'ai_edit' | 'upload';
  operationId: string | null;
  prompt: string | null;
  settings: Record<string, unknown>;
  createdAt: string;
  media: VersionMedia | null;
};
export type EditOperation = {
  id: string;
  shotId: string;
  sourceVersionId: string;
  resultVersionId: string | null;
  commentId: string | null;
  mode: AiEditMode;
  instruction: string;
  startSec: number;
  endSec: number;
  mask: EditMask | null;
  status: 'queued' | 'processing' | 'ready' | 'accepted' | 'rejected' | 'failed';
  generationJobId: string | null;
  estimateCredits: number;
  error: { message: string } | null;
  createdAt: string;
};
export type ShotComment = {
  id: string;
  shotId: string;
  versionId: string | null;
  author: 'user' | 'assistant';
  text: string;
  startSec: number | null;
  endSec: number | null;
  x: number | null;
  y: number | null;
  mask: EditMask | null;
  status: 'open' | 'processing' | 'ready_for_review' | 'accepted' | 'rejected' | 'failed' | 'resolved';
  operationId: string | null;
  createdAt: string;
};
export type StudioCharacter = {
  id: string;
  name: string;
  description: string;
  clothing: string;
  appearance: Record<string, string | undefined>;
  voice: Record<string, string | undefined>;
  styleMeta: Record<string, string>;
  /** The approved (primary) reference image. */
  imageUrl: string | null;
  /** Made for this project (otherwise a saved character it uses). */
  inProject: boolean;
};
export type StudioShot = {
  id: string;
  number: number;
  /** Place inside its scene (script order). */
  index: number;
  sceneId: string;
  approved: boolean;
  characterIds: string[];
  dialogue: { speaker: string; line: string; characterId?: string }[];
  sfx: string | null;
  continuityFlags: { kind: string; message: string; severity: 'info' | 'warn' }[];
  /** The storyboard frame is a labelled placeholder (test mode), not an AI image. */
  storyboardIsFixture: boolean;
  description: string;
  prompt: string;
  camera: string | null;
  shotType: string | null;
  durationSec: number;
  status: string;
  activeVersionId: string | null;
  storyboardUrl: string | null;
  versions: ShotVersion[];
  operations: EditOperation[];
  comments: ShotComment[];
};
export type StudioData = {
  kind: string;
  style: string | null;
  /** Generated shots the user took out of the movie (not put back automatically). */
  removed: string[];
  scenes: { id: string; index: number; title: string; synopsis: string; locationId: string | null; place: string | null }[];
  characters: StudioCharacter[];
  shots: StudioShot[];
};

export type EditEstimate = {
  available: boolean;
  fixture: boolean;
  credits: number;
  usd: number;
  seconds: number;
  model: string;
  whole: boolean;
  windowStart: number;
  windowEnd: number;
  rangeStart: number;
  rangeEnd: number;
  notes: string[];
};

export type PlanItem = { op: PlanOp; generative: boolean; why?: string; estimate?: EditEstimate | null; blocked?: string };
export type CopilotReply = { reply: string; plan: PlanItem[]; offline: boolean };

/** Shots with versions/comments/edits. Polls while an AI edit is running. */
export function useStudio(projectId: string) {
  return useQuery({
    queryKey: ['studio', projectId],
    queryFn: () => api<StudioData>(`/api/projects/${projectId}/shots`),
    // Poll while something is being made (AI edits, generations), so the graph updates by itself.
    refetchInterval: (q) => (q.state.data?.shots.some((s) => s.status === 'queued' || s.status === 'generating' || s.operations.some((o) => o.status === 'processing' || o.status === 'queued')) ? 3000 : false),
  });
}

export const activeVersion = (s: StudioShot) => s.versions.find((v) => v.id === s.activeVersionId) ?? s.versions.at(-1) ?? null;

export const COMMENT_STATUS_LABEL: Record<ShotComment['status'], string> = {
  open: 'Open',
  processing: 'Processing',
  ready_for_review: 'Ready for review',
  accepted: 'Accepted',
  rejected: 'Rejected',
  failed: 'Failed',
  resolved: 'Resolved',
};
