// Core domain vocabulary shared by the web app and the server.

export const ASPECT_RATIOS = ['9:16', '16:9', '1:1', '4:5'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const RESOLUTIONS = ['480p', '720p', '1080p', '1440p', '4k'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];
export const RESOLUTION_RANK: Record<Resolution, number> = {
  '480p': 1,
  '720p': 2,
  '1080p': 3,
  '1440p': 4,
  '4k': 5,
};

export const QUALITY_MODES = ['economy', 'balanced', 'high', 'cinematic'] as const;
export type QualityMode = (typeof QUALITY_MODES)[number];

export const QUALITY_MODE_INFO: Record<QualityMode, { label: string; blurb: string; defaultResolution: Resolution }> = {
  economy: {
    label: 'Economy',
    blurb: 'Quick, affordable clips for ideas and everyday posts.',
    defaultResolution: '720p',
  },
  balanced: {
    label: 'Balanced',
    blurb: 'Very good quality at a competitive cost. Recommended.',
    defaultResolution: '720p',
  },
  high: {
    label: 'High Quality',
    blurb: 'Stronger models and 1080p where it visibly helps.',
    defaultResolution: '1080p',
  },
  cinematic: {
    label: 'Cinematic',
    blurb: 'Flagship models for motion, consistency and filmic look.',
    defaultResolution: '1080p',
  },
};

export const QUICK_DURATIONS = [5, 8, 10, 15, 20, 30] as const;

export const GENERATION_MODES = ['text-to-video', 'image-to-video', 'first-last-frame', 'reference-to-video', 'video-to-video', 'extend'] as const;
export type GenerationMode = (typeof GENERATION_MODES)[number];

export const JOB_STATUSES = [
  'draft',
  'queued',
  'preparing',
  'generating',
  'processing',
  'rendering',
  'completed',
  'failed',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['completed', 'failed', 'cancelled'];

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  draft: 'Draft',
  queued: 'Queued',
  preparing: 'Preparing prompt & references',
  generating: 'Generating with AI model',
  processing: 'Processing media',
  rendering: 'Rendering final video',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ka', label: 'Georgian (ქართული)' },
  { code: 'ru', label: 'Russian (Русский)' },
] as const;
export type LanguageCode = (typeof LANGUAGES)[number]['code'];

export const STYLE_PRESETS = [
  { key: 'auto', label: 'Auto', prompt: '' },
  { key: 'cinematic', label: 'Cinematic', prompt: 'cinematic film look, shallow depth of field, anamorphic lens, rich contrast, film grain' },
  { key: 'photoreal', label: 'Photoreal', prompt: 'photorealistic, natural lighting, true-to-life textures, documentary realism' },
  { key: 'anime', label: 'Anime', prompt: 'high quality anime style, clean line art, vibrant cel shading' },
  { key: '3d', label: '3D Animation', prompt: 'stylized 3D animation, soft global illumination, appealing rounded character design' },
  { key: 'commercial', label: 'Commercial', prompt: 'premium commercial look, studio lighting, crisp product detail, glossy reflections' },
  { key: 'vintage', label: 'Vintage Film', prompt: '16mm vintage film stock, warm halation, gentle grain, soft vignette' },
  { key: 'neon', label: 'Neon Noir', prompt: 'neon-lit night scene, moody noir atmosphere, wet reflective surfaces, cyan and magenta highlights' },
  { key: 'dreamy', label: 'Dreamy', prompt: 'soft dreamy haze, pastel palette, bloom, gentle slow motion' },
  { key: 'documentary', label: 'Documentary', prompt: 'handheld documentary style, natural available light, authentic moments' },
  { key: 'claymation', label: 'Claymation', prompt: 'claymation stop-motion style, handcrafted textures, tactile miniature sets' },
] as const;
export type StyleKey = (typeof STYLE_PRESETS)[number]['key'];

export const CAMERA_PRESETS = [
  { key: 'dolly_in', label: 'Dolly In', prompt: 'slow dolly-in camera move toward the subject' },
  { key: 'dolly_out', label: 'Dolly Out', prompt: 'smooth dolly-out camera move revealing the scene' },
  { key: 'tracking', label: 'Tracking', prompt: 'tracking shot following the subject at matching speed' },
  { key: 'orbit', label: 'Orbit', prompt: 'camera orbits around the subject in a smooth arc' },
  { key: 'pan', label: 'Pan', prompt: 'slow horizontal camera pan across the scene' },
  { key: 'tilt', label: 'Tilt', prompt: 'vertical camera tilt revealing the subject' },
  { key: 'crane', label: 'Crane', prompt: 'sweeping crane shot rising above the scene' },
  { key: 'aerial', label: 'Aerial', prompt: 'aerial drone shot high above the landscape' },
  { key: 'handheld', label: 'Handheld', prompt: 'handheld camera with subtle natural shake' },
  { key: 'slow_motion', label: 'Slow Motion', prompt: 'graceful slow-motion footage' },
  { key: 'static', label: 'Static Cinematic', prompt: 'locked-off static cinematic frame' },
  { key: 'close_up', label: 'Close-Up', prompt: 'intimate close-up shot' },
  { key: 'medium', label: 'Medium Shot', prompt: 'medium shot framing from the waist up' },
  { key: 'wide', label: 'Wide Shot', prompt: 'wide establishing shot' },
] as const;
export type CameraKey = (typeof CAMERA_PRESETS)[number]['key'];

export const LIGHTING_PRESETS = [
  { key: 'golden_hour', label: 'Golden Hour', prompt: 'warm golden-hour sunlight with long soft shadows' },
  { key: 'blue_hour', label: 'Blue Hour', prompt: 'cool blue-hour twilight ambience' },
  { key: 'studio', label: 'Studio Softbox', prompt: 'clean studio lighting with large softboxes' },
  { key: 'low_key', label: 'Low Key', prompt: 'dramatic low-key lighting with deep shadows' },
  { key: 'high_key', label: 'High Key', prompt: 'bright airy high-key lighting' },
  { key: 'neon', label: 'Neon Practicals', prompt: 'colorful neon practical lights' },
  { key: 'overcast', label: 'Overcast', prompt: 'soft diffused overcast daylight' },
  { key: 'candle', label: 'Candlelight', prompt: 'flickering warm candlelight' },
] as const;

export const MOODS = ['Epic', 'Mysterious', 'Joyful', 'Melancholic', 'Tense', 'Romantic', 'Playful', 'Serene', 'Inspiring', 'Dark'] as const;

export const FILM_STYLES = [
  { key: 'blockbuster', label: 'Blockbuster', prompt: 'big-budget blockbuster cinematography' },
  { key: 'indie', label: 'Indie Drama', prompt: 'intimate indie drama cinematography' },
  { key: 'noir', label: 'Film Noir', prompt: 'classic film noir, hard shadows' },
  { key: 'scifi', label: 'Sci-Fi', prompt: 'sleek science-fiction production design' },
  { key: 'fantasy', label: 'Fantasy', prompt: 'lush fantasy production design' },
  { key: 'wes', label: 'Symmetric Pastel', prompt: 'symmetrical centered compositions, pastel palette' },
  { key: 'horror', label: 'Horror', prompt: 'unsettling horror atmosphere' },
] as const;

export const SHOT_TYPES = [
  'Extreme Wide',
  'Wide',
  'Full',
  'Medium',
  'Medium Close-Up',
  'Close-Up',
  'Extreme Close-Up',
  'Over-the-Shoulder',
  'POV',
  'Insert',
] as const;

export const LENSES = [
  { key: '14mm', label: '14mm ultra-wide', prompt: 'shot on a 14mm ultra-wide lens' },
  { key: '24mm', label: '24mm wide', prompt: 'shot on a 24mm wide lens' },
  { key: '35mm', label: '35mm natural', prompt: 'shot on a 35mm lens' },
  { key: '50mm', label: '50mm standard', prompt: 'shot on a 50mm lens' },
  { key: '85mm', label: '85mm portrait', prompt: 'shot on an 85mm portrait lens with creamy bokeh' },
  { key: '135mm', label: '135mm telephoto', prompt: 'compressed telephoto look from a 135mm lens' },
  { key: 'anamorphic', label: 'Anamorphic', prompt: 'anamorphic lens with oval bokeh and horizontal flares' },
  { key: 'macro', label: 'Macro', prompt: 'macro lens extreme detail' },
] as const;

export const COLOR_GRADES = [
  { key: 'none', label: 'Natural', prompt: '' },
  { key: 'teal_orange', label: 'Teal & Orange', prompt: 'teal and orange color grade' },
  { key: 'bleach', label: 'Bleach Bypass', prompt: 'desaturated bleach-bypass grade' },
  { key: 'kodak', label: 'Warm Film', prompt: 'warm Kodak-like film color grade' },
  { key: 'mono', label: 'Black & White', prompt: 'rich black and white grade' },
  { key: 'cyber', label: 'Cyber', prompt: 'cyan and magenta cyberpunk grade' },
] as const;

export const SOCIAL_PLATFORMS = {
  tiktok: {
    label: 'TikTok',
    aspectRatio: '9:16' as AspectRatio,
    maxDurationSec: 600,
    // Safe area as fractions of the frame (UI chrome covers the rest).
    safeArea: { top: 0.12, bottom: 0.2, left: 0.06, right: 0.16 },
  },
  reels: {
    label: 'Instagram Reels',
    aspectRatio: '9:16' as AspectRatio,
    maxDurationSec: 180,
    safeArea: { top: 0.14, bottom: 0.22, left: 0.06, right: 0.14 },
  },
  shorts: {
    label: 'YouTube Shorts',
    aspectRatio: '9:16' as AspectRatio,
    maxDurationSec: 180,
    safeArea: { top: 0.1, bottom: 0.18, left: 0.06, right: 0.14 },
  },
  facebook: {
    label: 'Facebook Reels',
    aspectRatio: '9:16' as AspectRatio,
    maxDurationSec: 90,
    safeArea: { top: 0.14, bottom: 0.25, left: 0.06, right: 0.14 },
  },
  feed: {
    label: 'Feed 4:5',
    aspectRatio: '4:5' as AspectRatio,
    maxDurationSec: 60,
    safeArea: { top: 0.05, bottom: 0.05, left: 0.05, right: 0.05 },
  },
  youtube: {
    label: 'YouTube 16:9',
    aspectRatio: '16:9' as AspectRatio,
    maxDurationSec: 3600,
    safeArea: { top: 0.05, bottom: 0.1, left: 0.05, right: 0.05 },
  },
} as const;
export type SocialPlatform = keyof typeof SOCIAL_PLATFORMS;

export const MOVIE_LENGTHS = [
  { seconds: 30, label: '30-second story' },
  { seconds: 60, label: '1-minute short' },
  { seconds: 120, label: '2-minute film' },
  { seconds: 180, label: '3-minute film' },
  { seconds: 300, label: '5-minute film' },
] as const;

export const ASPECT_DIMENSIONS: Record<AspectRatio, Record<'480p' | '720p' | '1080p', { width: number; height: number }>> = {
  '9:16': { '480p': { width: 480, height: 854 }, '720p': { width: 720, height: 1280 }, '1080p': { width: 1080, height: 1920 } },
  '16:9': { '480p': { width: 854, height: 480 }, '720p': { width: 1280, height: 720 }, '1080p': { width: 1920, height: 1080 } },
  '1:1': { '480p': { width: 480, height: 480 }, '720p': { width: 720, height: 720 }, '1080p': { width: 1080, height: 1080 } },
  '4:5': { '480p': { width: 480, height: 600 }, '720p': { width: 720, height: 900 }, '1080p': { width: 1080, height: 1350 } },
};
