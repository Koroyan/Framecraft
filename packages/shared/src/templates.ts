import type { AspectRatio, QualityMode, StyleKey, CameraKey } from './constants';

export type TemplateField = {
  key: string;
  label: string;
  placeholder?: string;
  type: 'text' | 'textarea' | 'image' | 'select';
  required?: boolean;
  options?: string[];
};

export type TemplateBeat = { label: string; seconds: number; guidance: string };

export type TemplateDefinition = {
  key: string;
  name: string;
  category: 'commerce' | 'social' | 'story' | 'education' | 'music' | 'brand';
  description: string;
  icon: string;
  platforms: string[];
  defaults: {
    aspectRatio: AspectRatio;
    durationSec: number;
    quality: QualityMode;
    style: StyleKey;
    camera?: CameraKey;
    nativeAudio: boolean;
  };
  fields: TemplateField[];
  /** Ordered story beats. Durations are scaled to the requested total. */
  beats: TemplateBeat[];
  /** Prompt pattern; {{field}} placeholders are filled from user input. */
  promptPattern: string;
  captionTone: string;
  /** Workflow the template launches: one clip, a multi-shot social edit, or a movie plan. */
  workflow: 'single-clip' | 'multi-shot' | 'movie';
  suggestImage?: boolean;
};

const vertical = (durationSec: number, quality: QualityMode, style: StyleKey, extra: Partial<TemplateDefinition['defaults']> = {}) => ({
  aspectRatio: '9:16' as AspectRatio,
  durationSec,
  quality,
  style,
  nativeAudio: true,
  ...extra,
});

export const TEMPLATES: TemplateDefinition[] = [
  {
    key: 'product-commercial',
    name: 'Product Commercial',
    category: 'commerce',
    description: 'A punchy product ad: hook, hero shot, benefit and call to action.',
    icon: 'ShoppingBag',
    platforms: ['tiktok', 'reels', 'shorts'],
    defaults: vertical(15, 'balanced', 'commercial', { camera: 'orbit' }),
    fields: [
      { key: 'product', label: 'Product name', placeholder: 'Aurora wireless earbuds', type: 'text', required: true },
      { key: 'benefit', label: 'Key benefit', placeholder: '40-hour battery, crystal sound', type: 'text', required: true },
      { key: 'audience', label: 'Who is it for?', placeholder: 'Commuters and gym lovers', type: 'text' },
      { key: 'image', label: 'Product photo (recommended)', type: 'image' },
    ],
    beats: [
      { label: 'Hook', seconds: 3, guidance: 'Eye-catching reveal of {{product}} in motion' },
      { label: 'Hero', seconds: 5, guidance: 'Premium hero shot of {{product}}, studio lighting, slow orbit' },
      { label: 'Benefit', seconds: 4, guidance: 'Show {{benefit}} in a real-life moment for {{audience}}' },
      { label: 'CTA', seconds: 3, guidance: 'Clean end frame with {{product}} centered, space for text' },
    ],
    promptPattern: 'Premium commercial of {{product}}. {{benefit}}. Glossy studio lighting, crisp detail, confident pacing.',
    captionTone: 'energetic, benefit-led, with a clear call to action',
    workflow: 'multi-shot',
    suggestImage: true,
  },
  {
    key: 'product-reveal',
    name: 'Cinematic Product Reveal',
    category: 'commerce',
    description: 'One luxurious, slow reveal shot — perfect for launches.',
    icon: 'Sparkles',
    platforms: ['tiktok', 'reels', 'shorts', 'youtube'],
    defaults: vertical(8, 'high', 'cinematic', { camera: 'dolly_in' }),
    fields: [
      { key: 'product', label: 'Product', placeholder: 'Matte black perfume bottle', type: 'text', required: true },
      { key: 'setting', label: 'Setting', placeholder: 'Dark marble pedestal with drifting smoke', type: 'text' },
      { key: 'image', label: 'Product photo', type: 'image' },
    ],
    beats: [{ label: 'Reveal', seconds: 8, guidance: 'Slow dramatic reveal of {{product}} on {{setting}}' }],
    promptPattern: 'Cinematic slow reveal of {{product}} on {{setting}}. Volumetric light, elegant reflections, luxury mood.',
    captionTone: 'minimal, luxurious, mysterious',
    workflow: 'single-clip',
    suggestImage: true,
  },
  {
    key: 'funny-ai',
    name: 'Funny AI Video',
    category: 'social',
    description: 'Absurd, scroll-stopping comedy moments built to be shared.',
    icon: 'Laugh',
    platforms: ['tiktok', 'reels', 'shorts'],
    defaults: vertical(10, 'economy', 'photoreal'),
    fields: [
      { key: 'premise', label: 'Funny premise', placeholder: 'A cat confidently teaching a yoga class', type: 'textarea', required: true },
      { key: 'twist', label: 'Punchline / twist', placeholder: 'The cat falls asleep mid-pose', type: 'text' },
    ],
    beats: [
      { label: 'Setup', seconds: 5, guidance: '{{premise}}' },
      { label: 'Punchline', seconds: 5, guidance: '{{twist}}' },
    ],
    promptPattern: '{{premise}}. Then: {{twist}}. Comedic timing, expressive reactions, bright natural light.',
    captionTone: 'playful, meme-aware, short',
    workflow: 'multi-shot',
  },
  {
    key: 'talking-character',
    name: 'Talking Character',
    category: 'social',
    description: 'A character speaks your script with native or generated voice.',
    icon: 'MessageCircle',
    platforms: ['tiktok', 'reels', 'shorts'],
    defaults: vertical(10, 'balanced', 'photoreal', { camera: 'medium' }),
    fields: [
      { key: 'character', label: 'Character', placeholder: 'A friendly robot barista', type: 'text', required: true },
      { key: 'script', label: 'What do they say?', placeholder: 'Good morning! Your coffee is ready…', type: 'textarea', required: true },
      { key: 'image', label: 'Character image (optional)', type: 'image' },
    ],
    beats: [{ label: 'Speech', seconds: 10, guidance: '{{character}} looks at camera and says: "{{script}}"' }],
    promptPattern: '{{character}} looking into the camera, speaking naturally with clear lip movement: "{{script}}". Medium shot, soft key light.',
    captionTone: 'conversational, first-person',
    workflow: 'single-clip',
    suggestImage: true,
  },
  {
    key: 'motivational',
    name: 'Motivational Reel',
    category: 'social',
    description: 'Epic visuals paired with a powerful quote or message.',
    icon: 'Flame',
    platforms: ['tiktok', 'reels', 'shorts'],
    defaults: vertical(15, 'balanced', 'cinematic', { camera: 'crane' }),
    fields: [
      { key: 'message', label: 'Message or quote', placeholder: 'Discipline beats motivation', type: 'textarea', required: true },
      { key: 'visual', label: 'Visual theme', placeholder: 'Runner at sunrise on a mountain ridge', type: 'text' },
    ],
    beats: [
      { label: 'Struggle', seconds: 5, guidance: '{{visual}}, effort and grit, early light' },
      { label: 'Rise', seconds: 5, guidance: 'Building momentum, camera rises' },
      { label: 'Triumph', seconds: 5, guidance: 'Victorious wide shot with space for "{{message}}"' },
    ],
    promptPattern: '{{visual}}. Epic, inspiring, golden light, sweeping camera.',
    captionTone: 'inspiring, bold, short sentences',
    workflow: 'multi-shot',
  },
  {
    key: 'travel',
    name: 'Travel Video',
    category: 'social',
    description: 'A dreamy destination montage that makes people want to go.',
    icon: 'Plane',
    platforms: ['tiktok', 'reels', 'shorts'],
    defaults: vertical(15, 'balanced', 'cinematic', { camera: 'aerial' }),
    fields: [
      { key: 'destination', label: 'Destination', placeholder: 'Tbilisi old town at sunset', type: 'text', required: true },
      { key: 'vibe', label: 'Vibe', placeholder: 'Warm, romantic, wandering', type: 'text' },
    ],
    beats: [
      { label: 'Arrival', seconds: 5, guidance: 'Aerial establishing shot of {{destination}}' },
      { label: 'Explore', seconds: 5, guidance: 'Street-level tracking shot through {{destination}}, {{vibe}}' },
      { label: 'Moment', seconds: 5, guidance: 'Golden hour hero moment overlooking {{destination}}' },
    ],
    promptPattern: '{{destination}}, {{vibe}}. Travel film, golden hour, smooth gimbal movement.',
    captionTone: 'wanderlust, sensory, place-specific',
    workflow: 'multi-shot',
  },
  {
    key: 'emotional-story',
    name: 'Emotional Story',
    category: 'story',
    description: 'A short heartfelt story with a beginning, turn and ending.',
    icon: 'Heart',
    platforms: ['tiktok', 'reels', 'youtube'],
    defaults: vertical(20, 'high', 'cinematic'),
    fields: [{ key: 'story', label: 'The story in one or two sentences', placeholder: 'An old man finds his late wife’s letters…', type: 'textarea', required: true }],
    beats: [
      { label: 'Setup', seconds: 6, guidance: 'Introduce the character and world of: {{story}}' },
      { label: 'Turn', seconds: 7, guidance: 'The emotional turning point' },
      { label: 'Resolution', seconds: 7, guidance: 'A quiet, moving resolution' },
    ],
    promptPattern: '{{story}}. Intimate cinematography, soft natural light, emotional performances.',
    captionTone: 'heartfelt, understated',
    workflow: 'multi-shot',
  },
  {
    key: 'fashion-ad',
    name: 'Fashion Advertisement',
    category: 'commerce',
    description: 'Editorial fashion film with runway-grade motion.',
    icon: 'Shirt',
    platforms: ['tiktok', 'reels'],
    defaults: vertical(10, 'high', 'commercial', { camera: 'tracking' }),
    fields: [
      { key: 'garment', label: 'Collection / garment', placeholder: 'Oversized silk trench coat in sand', type: 'text', required: true },
      { key: 'location', label: 'Location', placeholder: 'Brutalist concrete rooftop', type: 'text' },
      { key: 'image', label: 'Lookbook image', type: 'image' },
    ],
    beats: [
      { label: 'Walk', seconds: 5, guidance: 'Model walks toward camera wearing {{garment}} at {{location}}' },
      { label: 'Detail', seconds: 5, guidance: 'Fabric and texture close-ups of {{garment}}' },
    ],
    promptPattern: 'High-fashion editorial: {{garment}} at {{location}}. Confident walk, wind in fabric, editorial lighting.',
    captionTone: 'editorial, aspirational',
    workflow: 'multi-shot',
    suggestImage: true,
  },
  {
    key: 'beauty-ad',
    name: 'Beauty Advertisement',
    category: 'commerce',
    description: 'Glowing skincare & cosmetics visuals with texture shots.',
    icon: 'Flower2',
    platforms: ['tiktok', 'reels'],
    defaults: vertical(10, 'high', 'commercial', { camera: 'close_up' }),
    fields: [
      { key: 'product', label: 'Product', placeholder: 'Vitamin C glow serum', type: 'text', required: true },
      { key: 'texture', label: 'Texture / hero detail', placeholder: 'Golden droplets on glass', type: 'text' },
      { key: 'image', label: 'Product photo', type: 'image' },
    ],
    beats: [
      { label: 'Texture', seconds: 5, guidance: 'Macro shot of {{texture}}' },
      { label: 'Glow', seconds: 5, guidance: '{{product}} hero shot with soft glowing light' },
    ],
    promptPattern: '{{product}} beauty commercial. {{texture}}. Soft diffused light, dewy highlights, clean pastel set.',
    captionTone: 'fresh, self-care, benefit-led',
    workflow: 'multi-shot',
    suggestImage: true,
  },
  {
    key: 'restaurant',
    name: 'Restaurant Promotion',
    category: 'brand',
    description: 'Mouth-watering food shots and atmosphere for your venue.',
    icon: 'UtensilsCrossed',
    platforms: ['tiktok', 'reels', 'facebook'],
    defaults: vertical(15, 'balanced', 'commercial', { camera: 'dolly_in' }),
    fields: [
      { key: 'venue', label: 'Restaurant name', placeholder: 'Salobie Bia', type: 'text', required: true },
      { key: 'dish', label: 'Signature dish', placeholder: 'Khachapuri fresh from the oven', type: 'text', required: true },
      { key: 'offer', label: 'Offer / CTA', placeholder: 'Book your table this weekend', type: 'text' },
    ],
    beats: [
      { label: 'Sizzle', seconds: 5, guidance: 'Close-up of {{dish}}, steam and texture' },
      { label: 'Atmosphere', seconds: 5, guidance: 'Warm interior of {{venue}} with happy guests' },
      { label: 'Offer', seconds: 5, guidance: '{{dish}} plated beautifully, space for "{{offer}}"' },
    ],
    promptPattern: '{{dish}} at {{venue}}. Food cinematography, steam, warm tungsten light, appetizing detail.',
    captionTone: 'warm, appetizing, local',
    workflow: 'multi-shot',
  },
  {
    key: 'real-estate',
    name: 'Real Estate Promotion',
    category: 'brand',
    description: 'Elegant property walkthrough from a listing photo.',
    icon: 'Home',
    platforms: ['reels', 'facebook', 'youtube'],
    defaults: vertical(15, 'balanced', 'photoreal', { camera: 'dolly_in' }),
    fields: [
      { key: 'property', label: 'Property', placeholder: 'Modern 3-bedroom villa with pool', type: 'text', required: true },
      { key: 'highlight', label: 'Highlight', placeholder: 'Floor-to-ceiling sea views', type: 'text' },
      { key: 'image', label: 'Listing photo', type: 'image' },
    ],
    beats: [
      { label: 'Exterior', seconds: 5, guidance: 'Exterior approach of {{property}}' },
      { label: 'Interior', seconds: 5, guidance: 'Smooth walkthrough revealing {{highlight}}' },
      { label: 'Lifestyle', seconds: 5, guidance: 'Golden-hour lifestyle moment at {{property}}' },
    ],
    promptPattern: '{{property}}. {{highlight}}. Architectural photography look, smooth gimbal walkthrough, bright natural light.',
    captionTone: 'professional, aspirational, factual',
    workflow: 'multi-shot',
    suggestImage: true,
  },
  {
    key: 'educational',
    name: 'Educational Short',
    category: 'education',
    description: 'Explain one idea clearly with narration and visuals.',
    icon: 'GraduationCap',
    platforms: ['tiktok', 'shorts', 'reels'],
    defaults: vertical(30, 'economy', '3d', { nativeAudio: false }),
    fields: [
      { key: 'topic', label: 'Topic', placeholder: 'Why the sky is blue', type: 'text', required: true },
      { key: 'level', label: 'Audience level', type: 'select', options: ['Kids', 'General', 'Advanced'] },
    ],
    beats: [
      { label: 'Question', seconds: 6, guidance: 'Hook question about {{topic}}' },
      { label: 'Explain', seconds: 16, guidance: 'Clear visual explanation of {{topic}} for {{level}} audience' },
      { label: 'Takeaway', seconds: 8, guidance: 'Memorable takeaway visual' },
    ],
    promptPattern: 'Clear educational visual explaining {{topic}}. Clean 3D illustration style, simple shapes, bright colors.',
    captionTone: 'curious, clear, factual',
    workflow: 'multi-shot',
  },
  {
    key: 'mini-documentary',
    name: 'Mini Documentary',
    category: 'education',
    description: 'A narrated micro-documentary with real-feeling footage.',
    icon: 'Film',
    platforms: ['youtube', 'shorts', 'reels'],
    defaults: { aspectRatio: '16:9', durationSec: 60, quality: 'balanced', style: 'documentary', nativeAudio: false },
    fields: [
      { key: 'subject', label: 'Subject', placeholder: 'The last glassblowers of Murano', type: 'text', required: true },
      { key: 'angle', label: 'Angle', placeholder: 'Craft, heritage and change', type: 'text' },
    ],
    beats: [
      { label: 'Cold open', seconds: 10, guidance: 'Atmospheric opening on {{subject}}' },
      { label: 'Context', seconds: 20, guidance: 'Context and history of {{subject}}' },
      { label: 'Conflict', seconds: 15, guidance: '{{angle}}' },
      { label: 'Closing', seconds: 15, guidance: 'Reflective closing image' },
    ],
    promptPattern: 'Documentary footage of {{subject}}. {{angle}}. Natural light, handheld, authentic textures.',
    captionTone: 'thoughtful, informative',
    workflow: 'movie',
  },
  {
    key: 'music-visualizer',
    name: 'Music Visualizer',
    category: 'music',
    description: 'Looping, mood-matched visuals for your track.',
    icon: 'Music',
    platforms: ['tiktok', 'reels', 'youtube'],
    defaults: vertical(15, 'economy', 'neon', { nativeAudio: false }),
    fields: [
      { key: 'genre', label: 'Genre / mood', placeholder: 'Dreamy synthwave', type: 'text', required: true },
      { key: 'imagery', label: 'Imagery', placeholder: 'Endless neon highway under a purple sky', type: 'text' },
    ],
    beats: [
      { label: 'Loop A', seconds: 8, guidance: '{{imagery}}, rhythmic motion matching {{genre}}' },
      { label: 'Loop B', seconds: 7, guidance: 'Abstract variation of {{imagery}}' },
    ],
    promptPattern: '{{imagery}}. Visuals for {{genre}} music, rhythmic motion, seamless flow.',
    captionTone: 'vibey, minimal',
    workflow: 'multi-shot',
  },
  {
    key: 'character-story',
    name: 'AI Character Story',
    category: 'story',
    description: 'A recurring character on a short adventure, kept consistent.',
    icon: 'UserRound',
    platforms: ['tiktok', 'reels', 'shorts'],
    defaults: vertical(20, 'balanced', '3d'),
    fields: [
      { key: 'character', label: 'Character', placeholder: 'A tiny fox explorer with a red scarf', type: 'text', required: true },
      { key: 'adventure', label: 'Adventure', placeholder: 'Finds a glowing map in the forest', type: 'textarea', required: true },
    ],
    beats: [
      { label: 'Intro', seconds: 6, guidance: 'Introduce {{character}}' },
      { label: 'Adventure', seconds: 8, guidance: '{{character}}: {{adventure}}' },
      { label: 'Payoff', seconds: 6, guidance: 'Charming payoff moment for {{character}}' },
    ],
    promptPattern: '{{character}}. {{adventure}}. Consistent character design, warm storybook lighting.',
    captionTone: 'whimsical, episodic',
    workflow: 'multi-shot',
  },
  {
    key: 'before-after',
    name: 'Before / After',
    category: 'social',
    description: 'A satisfying transformation from a before image to an after.',
    icon: 'ArrowLeftRight',
    platforms: ['tiktok', 'reels'],
    defaults: vertical(8, 'balanced', 'photoreal'),
    fields: [
      { key: 'before', label: 'Before', placeholder: 'Messy empty garage', type: 'text', required: true },
      { key: 'after', label: 'After', placeholder: 'Cozy home gym with warm lights', type: 'text', required: true },
      { key: 'image', label: 'Before photo (first frame)', type: 'image' },
    ],
    beats: [{ label: 'Transform', seconds: 8, guidance: 'Smooth transformation from {{before}} into {{after}}' }],
    promptPattern: 'Seamless transformation from {{before}} to {{after}}. Satisfying, continuous camera move.',
    captionTone: 'satisfying, proud',
    workflow: 'single-clip',
    suggestImage: true,
  },
  {
    key: 'brand-promo',
    name: 'Brand Promotion',
    category: 'brand',
    description: 'Show what your brand stands for, with your colors and logo.',
    icon: 'BadgeCheck',
    platforms: ['tiktok', 'reels', 'youtube', 'facebook'],
    defaults: vertical(15, 'balanced', 'commercial'),
    fields: [
      { key: 'brand', label: 'Brand', placeholder: 'Kvali Coffee Roasters', type: 'text', required: true },
      { key: 'values', label: 'What you stand for', placeholder: 'Small-batch, ethically sourced', type: 'text', required: true },
      { key: 'cta', label: 'Call to action', placeholder: 'Order online today', type: 'text' },
    ],
    beats: [
      { label: 'Identity', seconds: 5, guidance: 'Visual metaphor of {{values}}' },
      { label: 'Craft', seconds: 5, guidance: 'People of {{brand}} at work' },
      { label: 'CTA', seconds: 5, guidance: 'Brand end card space for "{{cta}}"' },
    ],
    promptPattern: '{{brand}} brand film: {{values}}. Authentic, premium, human.',
    captionTone: 'on-brand, confident',
    workflow: 'multi-shot',
  },
  {
    key: 'gift-ad',
    name: 'Gift Advertisement',
    category: 'commerce',
    description: 'Seasonal gifting moment with unboxing magic.',
    icon: 'Gift',
    platforms: ['tiktok', 'reels', 'facebook'],
    defaults: vertical(10, 'balanced', 'dreamy'),
    fields: [
      { key: 'gift', label: 'Gift', placeholder: 'Hand-made ceramic mug set', type: 'text', required: true },
      { key: 'occasion', label: 'Occasion', placeholder: 'New Year', type: 'text' },
      { key: 'image', label: 'Gift photo', type: 'image' },
    ],
    beats: [
      { label: 'Anticipation', seconds: 4, guidance: 'Wrapped gift glowing under warm {{occasion}} lights' },
      { label: 'Unboxing', seconds: 6, guidance: 'Delighted unboxing revealing {{gift}}' },
    ],
    promptPattern: '{{gift}} as a {{occasion}} gift. Cozy bokeh lights, warm smiles, magical unboxing.',
    captionTone: 'warm, festive',
    workflow: 'multi-shot',
    suggestImage: true,
  },
  {
    key: 'mini-movie',
    name: 'AI Mini Movie',
    category: 'story',
    description: 'A multi-scene micro film with characters, dialogue and music.',
    icon: 'Clapperboard',
    platforms: ['youtube', 'tiktok'],
    defaults: { aspectRatio: '16:9', durationSec: 60, quality: 'high', style: 'cinematic', nativeAudio: true },
    fields: [
      { key: 'logline', label: 'Logline', placeholder: 'A detective investigates a mysterious abandoned city', type: 'textarea', required: true },
      { key: 'genre', label: 'Genre', type: 'select', options: ['Sci-Fi', 'Drama', 'Comedy', 'Thriller', 'Fantasy', 'Horror', 'Romance'] },
    ],
    beats: [
      { label: 'Act I', seconds: 15, guidance: 'Setup' },
      { label: 'Act II', seconds: 30, guidance: 'Confrontation' },
      { label: 'Act III', seconds: 15, guidance: 'Resolution' },
    ],
    promptPattern: '{{logline}}. {{genre}} film.',
    captionTone: 'cinematic teaser',
    workflow: 'movie',
  },
];

export function fillTemplate(pattern: string, values: Record<string, string | undefined>): string {
  return (
    pattern
      .replace(/\{\{(\w+)\}\}/g, (_, key: string) => (values[key] ?? '').trim())
      // Empty fields leave runs like ". ." or ", ." — keep only the first mark.
      .replace(/\s*([.,:;])(?:\s*[.,:;])+/g, '$1')
      .replace(/\s+([.,:;])/g, '$1')
      // Restore the space after a mark when a word follows (keeps "4:5" and "2.5" intact).
      .replace(/([.,:;])(?=\p{L})/gu, '$1 ')
      .replace(/^[\s.,:;]+/, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
  );
}

/** Scale template beats to a requested total duration, keeping proportions (min 2s each). */
export function scaleBeats(beats: TemplateBeat[], totalSec: number): TemplateBeat[] {
  const sum = beats.reduce((s, b) => s + b.seconds, 0) || 1;
  const scaled = beats.map((b) => ({ ...b, seconds: Math.max(2, Math.round((b.seconds / sum) * totalSec)) }));
  const diff = totalSec - scaled.reduce((s, b) => s + b.seconds, 0);
  if (scaled.length && diff !== 0) {
    const last = scaled[scaled.length - 1]!;
    last.seconds = Math.max(2, last.seconds + diff);
  }
  return scaled;
}

export function getTemplate(key: string): TemplateDefinition | undefined {
  return TEMPLATES.find((t) => t.key === key);
}
