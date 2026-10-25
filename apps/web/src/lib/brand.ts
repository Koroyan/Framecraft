'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type BrandKit = { id: string; name: string; logoAssetId: string | null; logoUrl: string | null; colors: { primary: string; secondary: string; text: string }; voice: string; products: string; ctas: string[]; slogans: string[]; website: string | null; musicStyle: string; offers: string; handles: Record<string, string> };

export function useBrandKits() {
  return useQuery({ queryKey: ['brand-kits'], queryFn: () => api<{ brandKits: BrandKit[] }>('/api/brand-kits') });
}

