import { requestJson } from '../video/base';
import { ProviderError, ProviderHttpError, type HttpFetch } from '../video/types';
import { AUDIO_MODELS } from '../../catalog/media-models';

/**
 * ElevenLabs adapter (direct). Docs: https://elevenlabs.io/docs/api-reference
 * Auth header: `xi-api-key`. Endpoints: /v1/text-to-speech/{voice_id}, /v1/speech-to-text,
 * /v1/sound-generation, /v1/music. Responses for TTS/SFX/music are binary audio.
 */
export const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io';

/** A few of ElevenLabs' public premade voices; any voice id from the user's account also works. */
export const DEFAULT_VOICES = [
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George — warm narrator' },
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel — calm, clear' },
  { id: 'TX3LPaxmHKxFdv7VOQHJ', name: 'Liam — energetic' },
  { id: 'XB0fDUnXU5powFXDhCwa', name: 'Charlotte — expressive' },
];

export type TranscriptWord = { text: string; start: number; end: number; type: string };

export function chooseTtsModel(language: string, quality: 'standard' | 'high' = 'standard'): string {
  const candidates = AUDIO_MODELS.filter((m) => m.task === 'tts' && m.status === 'active' && m.languages?.includes(language));
  const sorted = candidates.sort((a, b) => (quality === 'high' ? b.qualityTier - a.qualityTier : a.usdPerUnit - b.usdPerUnit || b.qualityTier - a.qualityTier));
  return sorted[0]?.providerModelId ?? 'eleven_v4_turbo';
}

export function estimateTtsUsd(text: string, modelId: string): number {
  const m = AUDIO_MODELS.find((x) => x.providerModelId === modelId);
  return ((m?.usdPerUnit ?? 0.08) * text.length) / 1000;
}

/** Group ElevenLabs character timings into words (split on whitespace). */
export function alignmentToWords(a: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } | null | undefined) {
  const words: { text: string; start: number; end: number }[] = [];
  if (!a?.characters?.length) return words;
  let cur: { text: string; start: number; end: number } | undefined;
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (cur) words.push(cur);
      cur = undefined;
      return;
    }
    const start = a.character_start_times_seconds[i] ?? 0;
    const end = a.character_end_times_seconds[i] ?? start;
    cur = cur ? { ...cur, text: cur.text + ch, end } : { text: ch, start, end };
  });
  if (cur) words.push(cur);
  return words;
}

export class ElevenLabsProvider {
  readonly key = 'elevenlabs' as const;
  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: HttpFetch = fetch,
    private readonly baseUrl = ELEVENLABS_BASE_URL,
  ) {}

  isConfigured() {
    return Boolean(this.apiKey);
  }

  private assertConfigured() {
    if (!this.apiKey) throw new ProviderError({ code: 'auth', message: 'ElevenLabs is not configured (ELEVENLABS_API_KEY missing)', retryable: false, providerRefunds: true });
  }

  private async binary(url: string, body: unknown): Promise<Buffer> {
    this.assertConfigured();
    const res = await this.fetchImpl(url, { method: 'POST', headers: { 'xi-api-key': this.apiKey!, 'Content-Type': 'application/json', Accept: 'audio/mpeg' }, body: JSON.stringify(body) });
    if (!res.ok) {
      let detail: unknown = undefined;
      try {
        detail = await res.json();
      } catch {
        /* ignore */
      }
      throw new ProviderHttpError(res.status, detail, `ElevenLabs HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  buildTtsRequest(p: { text: string; voiceId: string; modelId: string; language?: string }) {
    const body: Record<string, unknown> = { text: p.text, model_id: p.modelId };
    // language_code is not supported by multilingual_v2 models.
    if (p.language && !p.modelId.includes('multilingual_v2')) body.language_code = p.language;
    return { url: `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(p.voiceId)}?output_format=mp3_44100_128`, body };
  }

  async textToSpeech(p: { text: string; voiceId: string; modelId: string; language?: string }): Promise<Buffer> {
    const { url, body } = this.buildTtsRequest(p);
    return this.binary(url, body);
  }

  /**
   * TTS plus per-word timings (from ElevenLabs' character alignment), so subtitles can appear
   * exactly when each word is spoken.
   */
  async textToSpeechTimed(p: { text: string; voiceId: string; modelId: string; language?: string }): Promise<{ audio: Buffer; words: { text: string; start: number; end: number }[] }> {
    this.assertConfigured();
    const { url, body } = this.buildTtsRequest(p);
    const res = await requestJson<{ audio_base64: string; alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } | null }>(
      this.fetchImpl,
      url.replace('?', '/with-timestamps?'),
      { method: 'POST', headers: { 'xi-api-key': this.apiKey!, 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeoutMs: 120_000 },
    );
    return { audio: Buffer.from(res.audio_base64, 'base64'), words: alignmentToWords(res.alignment) };
  }

  async soundEffect(p: { text: string; durationSec?: number }): Promise<Buffer> {
    return this.binary(`${this.baseUrl}/v1/sound-generation?output_format=mp3_44100_128`, {
      text: p.text,
      duration_seconds: p.durationSec ? Math.min(30, Math.max(0.5, p.durationSec)) : null,
      model_id: 'eleven_text_to_sound_v2',
    });
  }

  async music(p: { prompt: string; lengthSec: number; instrumental?: boolean }): Promise<Buffer> {
    return this.binary(`${this.baseUrl}/v1/music`, {
      prompt: p.prompt,
      music_length_ms: Math.min(600_000, Math.max(3_000, Math.round(p.lengthSec * 1000))),
      model_id: 'music_v2_5',
      force_instrumental: p.instrumental ?? true,
    });
  }

  async transcribe(p: { audio: Buffer; filename: string; language?: string }): Promise<{ text: string; language: string; words: TranscriptWord[] }> {
    this.assertConfigured();
    const form = new FormData();
    form.set('model_id', 'scribe_v2');
    form.set('timestamps_granularity', 'word');
    if (p.language) form.set('language_code', p.language);
    form.set('file', new Blob([new Uint8Array(p.audio)]), p.filename);
    const res = await requestJson<{ text: string; language_code: string; words?: TranscriptWord[] }>(this.fetchImpl, `${this.baseUrl}/v1/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey! },
      body: form,
      timeoutMs: 10 * 60_000,
    });
    return { text: res.text, language: res.language_code, words: (res.words ?? []).filter((w) => w.type === 'word') };
  }

  /** Voice Library search (needs the key's "Voices: read" permission). Native speakers give the most natural accent. */
  async sharedVoices(p: { language: string; gender?: 'male' | 'female'; pageSize?: number }) {
    this.assertConfigured();
    const q = new URLSearchParams({ language: p.language, page_size: String(p.pageSize ?? 30), sort: 'cloned_by_count' });
    if (p.gender) q.set('gender', p.gender);
    const res = await requestJson<{ voices: { voice_id: string; public_owner_id: string; name: string; gender?: string; age?: string; accent?: string; language?: string; description?: string; preview_url?: string; cloned_by_count?: number; free_users_allowed?: boolean }[] }>(
      this.fetchImpl,
      `${this.baseUrl}/v1/shared-voices?${q}`,
      { headers: { 'xi-api-key': this.apiKey! } },
    );
    return res.voices.map((v) => ({ voiceId: v.voice_id, publicOwnerId: v.public_owner_id, name: v.name, gender: v.gender, age: v.age, accent: v.accent, language: v.language, description: v.description, previewUrl: v.preview_url, uses: v.cloned_by_count ?? 0 }));
  }

  /** Add a Voice Library voice to the account so the API can use it (needs "Voices: write"). Free; uses a voice slot. */
  async addSharedVoice(publicOwnerId: string, voiceId: string, name: string): Promise<string> {
    this.assertConfigured();
    const res = await requestJson<{ voice_id: string }>(this.fetchImpl, `${this.baseUrl}/v1/voices/add/${encodeURIComponent(publicOwnerId)}/${encodeURIComponent(voiceId)}`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_name: name.slice(0, 100) }),
    });
    return res.voice_id;
  }

  async checkCredentials(): Promise<{ ok: boolean; message: string }> {
    if (!this.apiKey) return { ok: false, message: 'ELEVENLABS_API_KEY is not set' };
    try {
      await requestJson(this.fetchImpl, `${this.baseUrl}/v1/models`, { headers: { 'xi-api-key': this.apiKey } });
      return { ok: true, message: 'Authenticated' };
    } catch (err) {
      return { ok: false, message: `ElevenLabs credential check failed: ${(err as Error).message}` };
    }
  }
}
