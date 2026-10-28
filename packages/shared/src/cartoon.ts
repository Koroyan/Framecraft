import { z } from 'zod';
import { aspectRatioSchema, languageSchema } from './schemas';

/*
 * Cartoon styles: original style definitions — no studio names and no existing characters. Each
 * style has the words the video and image models get, how a still frame of it looks, and the
 * colours of its card (an illustration of the style, not an AI result).
 */
export const CARTOON_STYLES = [
  { key: 'cartoon_3d', label: '3D cartoon', hint: 'Rounded shapes, soft light, big expressions', prompt: 'stylized 3D cartoon animation, rounded appealing character shapes, soft global illumination, expressive faces, vibrant colours', still: 'stylized 3D cartoon render', swatch: ['#FFB86B', '#6BC5FF', '#2B2D6E'] },
  { key: 'cartoon_feature', label: 'Animated feature', hint: 'Cinematic light, painterly worlds', prompt: 'stylized animated feature film look, cinematic lighting, painterly textured environments, appealing character design, rich colour script', still: 'animated feature film frame', swatch: ['#F6C177', '#9CCFD8', '#3E3A5E'] },
  { key: 'cartoon_2d', label: '2D hand-drawn', hint: 'Ink lines, cel shading, painted backgrounds', prompt: 'traditional 2D hand-drawn animation, clean ink outlines, flat cel shading, hand-painted backgrounds, lively squash-and-stretch motion', still: '2D hand-drawn animation cel', swatch: ['#FCE38A', '#F38181', '#95E1D3'] },
  { key: 'cartoon_anime', label: 'Anime', hint: 'Crisp line art, dramatic light', prompt: 'anime-style 2D animation, crisp line art, cel shading, dramatic lighting, detailed backgrounds, expressive eyes', still: 'anime-style animation frame', swatch: ['#A3D8F4', '#F7A6C1', '#2E3A59'] },
  { key: 'cartoon_clay', label: 'Clay stop motion', hint: 'Handmade, tactile, miniature sets', prompt: 'clay stop-motion animation, handmade plasticine characters with fingerprint texture, miniature practical sets, soft studio lighting, slightly stepped motion', still: 'clay stop-motion photograph', swatch: ['#E9A178', '#A8D5BA', '#6B4F3A'] },
  { key: 'cartoon_paper', label: 'Paper cut-out', hint: 'Layered paper, soft shadows', prompt: 'paper cut-out animation, layered textured craft paper, visible cut edges, soft drop shadows between layers, handcrafted charm', still: 'paper cut-out animation frame', swatch: ['#F4D35E', '#EE964B', '#0D3B66'] },
  { key: 'cartoon_vector', label: 'Minimal vector', hint: 'Flat shapes, few colours, smooth', prompt: 'minimal flat vector cartoon, simple geometric shapes, limited colour palette, clean smooth motion, no textures', still: 'flat vector illustration', swatch: ['#2EC4B6', '#FF9F1C', '#011627'] },
  { key: 'cartoon_comic', label: 'Comic book', hint: 'Bold ink, halftones, punchy colour', prompt: 'comic-book animation, bold ink outlines, halftone shading, punchy saturated colours, dynamic poses and framing', still: 'comic-book panel', swatch: ['#FFD23F', '#EE4266', '#3BCEAC'] },
  { key: 'cartoon_storybook', label: 'Storybook', hint: 'Watercolour, warm and gentle', prompt: 'storybook illustration brought to life, soft watercolour textures, gentle pencil lines, warm cosy light, calm pacing', still: 'watercolour storybook illustration', swatch: ['#F2CC8F', '#81B29A', '#E07A5F'] },
  { key: 'cartoon_kids', label: 'Kids learning', hint: 'Bright, simple, friendly', prompt: "bright friendly children's educational cartoon, simple clear shapes, cheerful saturated colours, easy-to-read expressions, gentle motion", still: "children's cartoon frame", swatch: ['#FFE66D', '#4ECDC4', '#FF6B6B'] },
  { key: 'cartoon_fantasy', label: 'Cinematic fantasy', hint: 'Epic light, magical worlds', prompt: 'cinematic fantasy animation, epic volumetric lighting, rich detailed magical environments, sweeping atmosphere', still: 'fantasy animation keyframe', swatch: ['#7F5AF0', '#2CB67D', '#16161A'] },
  { key: 'cartoon_mascot', label: 'Brand mascot', hint: 'Polished, clean, on-brand', prompt: 'polished branded mascot animation, clean stylized 3D character with simple readable shapes, brand colours, bright commercial lighting', still: 'polished mascot render', swatch: ['#FF8E3C', '#FFFFFE', '#0F0E17'] },
] as const;
export type CartoonStyleKey = (typeof CARTOON_STYLES)[number]['key'];
export const isCartoonStyle = (k?: string | null): k is CartoonStyleKey => CARTOON_STYLES.some((s) => s.key === k);

export const CARTOON_AUDIENCES = [
  { key: 'preschool', label: 'Little kids (3–6)', note: 'very simple story, gentle, no peril' },
  { key: 'kids', label: 'Kids (7–12)', note: 'playful, clear stakes, nothing frightening' },
  { key: 'family', label: 'Family', note: 'jokes for children and adults alike' },
  { key: 'teens', label: 'Teens', note: 'faster pace, wit' },
  { key: 'adults', label: 'Adults', note: 'grown-up humour and themes, still tasteful' },
  { key: 'customers', label: 'Customers (brand film)', note: 'friendly, clear, on-brand, ends with the brand' },
] as const;
export type CartoonAudience = (typeof CARTOON_AUDIENCES)[number]['key'];

/** How a still frame (storyboard / first frame) of this style is described to an image model. */
export function stillLook(style?: string | null): string {
  const c = CARTOON_STYLES.find((s) => s.key === style);
  if (c) return c.still;
  if (style === 'anime') return 'anime-style frame';
  if (style === '3d') return 'stylized 3D animation render';
  if (style === 'claymation') return 'clay stop-motion photograph';
  return 'photorealistic cinematic';
}

/** Well-known protected characters people ask for by name; Framecraft makes original ones. */
const PROTECTED = /\b(mickey|minnie mouse|donald duck|pikachu|pok[eé]mon|spongebob|elsa|olaf|shrek|peppa pig|spider-?man|batman|superman|super mario|luigi|sonic the hedgehog|bluey|paw patrol|minions?|hello kitty|winnie the pooh|simpsons?|scooby-?doo|bugs bunny|buzz lightyear|totoro|naruto|goku)\b/i;
export function protectedCharacterIn(text: string): string | null {
  return text.match(PROTECTED)?.[0] ?? null;
}

export const cartoonBriefSchema = z.object({
  idea: z.string().trim().min(10).max(2000),
  style: z.enum(CARTOON_STYLES.map((s) => s.key) as [CartoonStyleKey, ...CartoonStyleKey[]]),
  lengthSec: z.number().int().min(15).max(180).default(45),
  language: languageSchema.default('en'),
  audience: z.enum(CARTOON_AUDIENCES.map((a) => a.key) as [CartoonAudience, ...CartoonAudience[]]).default('family'),
  aspectRatio: aspectRatioSchema.default('16:9'),
  /** Characters talk to each other, a narrator tells the story, or music only. */
  voices: z.enum(['dialogue', 'narration', 'none']).default('dialogue'),
  /** Saved characters (Character Bible) to cast; their approved reference images keep them consistent. */
  characterIds: z.array(z.string().uuid()).max(6).default([]),
  /** Extra reference images (places, products, a hand-drawn sketch). */
  referenceAssetIds: z.array(z.string().uuid()).max(6).default([]),
  /** Brand film: the brand profile whose approved facts, colours and logo are used. */
  brandId: z.string().uuid().optional(),
  /** Brand film: the product to show (its own photos keep it recognisable). */
  productId: z.string().uuid().optional(),
});
export type CartoonBrief = z.infer<typeof cartoonBriefSchema>;

/** The story idea the AI Director plans from: the user's words plus the cartoon's own rules. */
export function cartoonIdea(b: Pick<CartoonBrief, 'idea' | 'style' | 'audience' | 'voices'>, cast: { name: string; description: string }[] = []): string {
  const style = CARTOON_STYLES.find((s) => s.key === b.style)!;
  const audience = CARTOON_AUDIENCES.find((a) => a.key === b.audience)!;
  const voices = b.voices === 'dialogue' ? 'Characters speak short lines of dialogue.' : b.voices === 'narration' ? 'A narrator tells the story; characters do not speak.' : 'No dialogue or narration: tell the story through action and music.';
  return [
    b.idea.trim(),
    '',
    `This is an original animated cartoon for ${audience.label.toLowerCase()} (${audience.note}).`,
    `Visual style for every shot: ${style.prompt}.`,
    voices,
    cast.length ? `Cast (keep each design identical in every shot): ${cast.map((c) => `${c.name} — ${c.description}`).join('; ')}.` : 'Design each character once and keep the design identical in every shot.',
    'Use only original characters — no existing or trademarked characters, logos or brands unless they are the user’s own.',
  ].join('\n');
}
