import type { Env } from '../../config/env';
import type { ProviderKey } from '../../catalog/types';
import { RunwayProvider } from './runway';
import { LtxProvider } from './ltx';
import { FalProvider } from './fal';
import { GoogleProvider } from './google';
import { ReplicateProvider } from './replicate';
import { FixtureProvider } from './fixture';
import type { HttpFetch, VideoProvider } from './types';

export type VideoProviderMap = Partial<Record<ProviderKey, VideoProvider>> & { fixture: FixtureProvider };

export function createVideoProviders(env: Env, fetchImpl: HttpFetch = fetch): VideoProviderMap {
  return {
    runway: new RunwayProvider(env.RUNWAYML_API_SECRET, fetchImpl),
    ltx: new LtxProvider(env.LTX_API_KEY, fetchImpl),
    fal: new FalProvider(env.FAL_KEY, fetchImpl),
    google: new GoogleProvider(env.GEMINI_API_KEY, fetchImpl),
    replicate: new ReplicateProvider(env.REPLICATE_API_TOKEN, fetchImpl),
    fixture: new FixtureProvider(),
  };
}

export const PROVIDER_INFO: Record<string, { displayName: string; envVar: string; docs: string }> = {
  runway: { displayName: 'Runway', envVar: 'RUNWAYML_API_SECRET', docs: 'https://docs.dev.runwayml.com/' },
  ltx: { displayName: 'LTX', envVar: 'LTX_API_KEY', docs: 'https://docs.ltx.io/' },
  fal: { displayName: 'fal.ai', envVar: 'FAL_KEY', docs: 'https://fal.ai/docs' },
  google: { displayName: 'Google Gemini API', envVar: 'GEMINI_API_KEY', docs: 'https://ai.google.dev/gemini-api/docs/video' },
  replicate: { displayName: 'Replicate', envVar: 'REPLICATE_API_TOKEN', docs: 'https://replicate.com/docs' },
  elevenlabs: { displayName: 'ElevenLabs', envVar: 'ELEVENLABS_API_KEY', docs: 'https://elevenlabs.io/docs' },
  anthropic: { displayName: 'Anthropic (AI Director)', envVar: 'ANTHROPIC_API_KEY', docs: 'https://docs.claude.com/' },
};

export * from './types';
