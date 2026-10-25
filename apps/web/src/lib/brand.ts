'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type BrandFact = { id: string; text: string; kind: 'about' | 'product' | 'claim' | 'audience' | 'contact' | 'price' | 'other'; sourceUrl: string | null; confidence: number; status: 'approved' | 'pending' | 'rejected' };
export type BrandSource = { url: string; kind: 'website' | 'social' | 'manual'; fetchedAt: string; status: 'read' | 'blocked' | 'manual'; note?: string };

export type BrandKit = {
  id: string;
  name: string;
  logoAssetId: string | null;
  logoUrl: string | null;
  colors: { primary: string; secondary: string; text: string };
  fonts?: { heading: string; body: string };
  voice: string;
  products: string;
  ctas: string[];
  slogans: string[];
  website: string | null;
  musicStyle: string;
  offers: string;
  handles: Record<string, string>;
  description: string;
  industry: string;
  audience: string;
  markets: string[];
  languages: string[];
  contact: { email?: string; phone?: string; address?: string };
  restrictions: string;
  vocabulary: string[];
  knowledge: { facts: BrandFact[]; sources: BrandSource[] };
  updatedAt?: string;
};

export type BrandProduct = {
  id: string;
  brandKitId: string;
  name: string;
  description: string;
  category: string;
  price: string;
  url: string | null;
  claims: string[];
  references: { assetId: string; view: string }[];
  mediaAssetIds: string[];
  coverUrl: string | null;
};

export type WebsiteDraft = {
  url: string;
  pages: { url: string; title: string; status: 'read' | 'skipped' | 'failed'; note?: string }[];
  name: string | null;
  description: string | null;
  slogan: string | null;
  industry: string | null;
  audienceSuggestions: string[];
  products: { name: string; description: string; price: string; url: string | null; imageUrls: string[]; sourceUrl: string; confidence: number }[];
  social: Record<string, string>;
  contact: { email?: string; phone?: string; address?: string };
  colors: string[];
  fonts: string[];
  logoUrl: string | null;
  imageUrls: { url: string; alt: string; sourceUrl: string }[];
  facts: BrandFact[];
  socialNotes: { platform: string; url: string; note: string }[];
  summarySource: 'llm' | 'offline';
};

export const EMPTY_BRAND: Omit<BrandKit, 'id' | 'logoUrl'> = {
  name: '',
  logoAssetId: null,
  colors: { primary: '#7C5CFF', secondary: '#111111', text: '#FFFFFF' },
  voice: '',
  products: '',
  ctas: [],
  slogans: [],
  website: null,
  musicStyle: '',
  offers: '',
  handles: {},
  description: '',
  industry: '',
  audience: '',
  markets: [],
  languages: [],
  contact: {},
  restrictions: '',
  vocabulary: [],
  knowledge: { facts: [], sources: [] },
};

export function useBrandKits() {
  return useQuery({ queryKey: ['brand-kits'], queryFn: () => api<{ brandKits: BrandKit[] }>('/api/brand-kits') });
}

export function useProducts(brandKitId: string | null | undefined) {
  return useQuery({ queryKey: ['brand-products', brandKitId], enabled: Boolean(brandKitId), queryFn: () => api<{ products: BrandProduct[] }>(`/api/brand-kits/${brandKitId}/products`) });
}

/** The body the API accepts for a brand kit (server-side fields left out). */
export function brandBody(b: Omit<BrandKit, 'id' | 'logoUrl'> & { id?: string; logoUrl?: string | null }) {
  return {
    name: b.name,
    logoAssetId: b.logoAssetId,
    colors: b.colors,
    ...(b.fonts ? { fonts: b.fonts } : {}),
    voice: b.voice,
    products: b.products,
    ctas: b.ctas.map((x) => x.trim()).filter(Boolean),
    slogans: b.slogans.map((x) => x.trim()).filter(Boolean),
    website: b.website || null,
    musicStyle: b.musicStyle,
    offers: b.offers,
    handles: b.handles,
    description: b.description,
    industry: b.industry,
    audience: b.audience,
    markets: b.markets.map((x) => x.trim()).filter(Boolean),
    languages: b.languages,
    contact: b.contact,
    restrictions: b.restrictions,
    vocabulary: b.vocabulary.map((x) => x.trim()).filter(Boolean),
    knowledge: b.knowledge,
  };
}

export const SOCIAL_PLATFORMS = ['instagram', 'facebook', 'tiktok', 'youtube', 'x', 'linkedin', 'pinterest'] as const;
