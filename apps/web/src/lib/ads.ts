'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type CampaignListItem = { id: string; title: string; status: string; projectId: string | null; updatedAt: string };

export function useCampaigns() {
  return useQuery({ queryKey: ['campaigns'], queryFn: () => api<{ campaigns: CampaignListItem[] }>('/api/ads/campaigns'), refetchInterval: (q) => (q.state.data?.campaigns.some((c) => ['analyzing', 'planning', 'assembling'].includes(c.status)) ? 5000 : false) });
}
