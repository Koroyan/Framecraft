'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { TERMINAL_JOB_STATUSES, type PublicJob } from '@framecraft/shared';
import { endpoints } from './api';

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: endpoints.me, staleTime: 10_000 });
}

export function useSystemStatus() {
  return useQuery({ queryKey: ['status'], queryFn: endpoints.status, staleTime: 60_000 });
}

export function useModels() {
  return useQuery({ queryKey: ['models'], queryFn: endpoints.models, staleTime: 60_000 });
}

export function useTemplates() {
  return useQuery({ queryKey: ['templates'], queryFn: endpoints.templates, staleTime: 300_000 });
}

/** Poll a job until it reaches a terminal state; refreshes wallet once it finishes. */
export function useJob(id: string | null | undefined) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['job', id],
    queryFn: async () => {
      const r = await endpoints.job(id!);
      if (TERMINAL_JOB_STATUSES.includes(r.job.status)) void qc.invalidateQueries({ queryKey: ['me'] });
      return r;
    },
    enabled: Boolean(id),
    refetchInterval: (q) => (q.state.data && TERMINAL_JOB_STATUSES.includes(q.state.data.job.status) ? false : 2500),
  });
}

export const isActive = (j: Pick<PublicJob, 'status'>) => !TERMINAL_JOB_STATUSES.includes(j.status);
