import { and, eq, inArray } from 'drizzle-orm';
import { cartoonIdea, protectedCharacterIn, type CartoonBrief, type MovieBrief } from '@framecraft/shared';
import type { AppContext } from '../context';
import { characterReferences, characters } from '../db/schema';
import { brandKits, brandProducts } from '../db/schema-ads';
import { AppError, notFound } from '../lib/errors';
import type { SessionLike } from '../generation/service';
import { createMovie } from './movie';

/*
 * "Create a Cartoon": a film with an original cartoon style, planned by the AI Director like any
 * film (story, characters, places, scenes, shots, dialogue, music), so every step stays editable in
 * the storyboard and graph. Saved characters (the Character Bible) are cast with their approved
 * reference image; a brand film adds only the brand's approved facts, its product photos and logo.
 */

export async function createCartoon(ctx: AppContext, user: SessionLike, input: CartoonBrief, idempotencyKey: string) {
  const who = protectedCharacterIn(input.idea);
  if (who) throw new AppError('protected_character', `Framecraft makes original characters. “${who}” belongs to someone else — describe your own character instead (it can look however you like).`, 422);

  const cast = input.characterIds.length ? await ctx.db.select().from(characters).where(and(inArray(characters.id, input.characterIds), eq(characters.userId, user.id))) : [];
  if (cast.length !== input.characterIds.length) throw notFound('Character');
  const refs = cast.length ? await ctx.db.select().from(characterReferences).where(inArray(characterReferences.characterId, cast.map((c) => c.id))) : [];

  const references: MovieBrief['references'] = [];
  const add = (assetId: string, note?: string) => {
    if (references.length < 12 && !references.some((r) => r.assetId === assetId)) references.push({ token: `photo${references.length + 1}`, assetId, ...(note ? { note } : {}) });
  };
  for (const c of cast) {
    // The approved (primary) reference first: it is what keeps the character's design stable.
    const ref = refs.filter((r) => r.characterId === c.id).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))[0];
    if (ref) add(ref.assetId, `${c.name} (character)`);
  }

  const brandLines: string[] = [];
  if (input.brandId) {
    const [brand] = await ctx.db.select().from(brandKits).where(and(eq(brandKits.id, input.brandId), eq(brandKits.userId, user.id)));
    if (!brand) throw notFound('Brand');
    const facts = brand.knowledge.facts.filter((f) => f.status === 'approved').map((f) => f.text);
    brandLines.push(
      `Brand film for ${brand.name}${brand.industry ? ` (${brand.industry})` : ''}. ${brand.description}`.trim(),
      facts.length ? `Use only these approved facts about the brand: ${facts.join(' | ')}.` : 'Make no factual claims about the brand (no prices, awards, numbers or testimonials).',
      brand.voice ? `Brand voice: ${brand.voice}.` : '',
      `Brand colours: ${brand.colors.primary} and ${brand.colors.secondary}.`,
      brand.restrictions ? `Never show or say: ${brand.restrictions}.` : '',
      brand.ctas[0] ? `End with this invitation: “${brand.ctas[0]}”.` : '',
    );
    if (input.productId) {
      const [product] = await ctx.db.select().from(brandProducts).where(and(eq(brandProducts.id, input.productId), eq(brandProducts.brandKitId, brand.id)));
      if (!product) throw notFound('Product');
      brandLines.push(`The product: ${product.name} — ${product.description}${product.claims.length ? ` (approved claims: ${product.claims.join('; ')})` : ''}. It must look exactly like its photos.`);
      for (const r of product.references.slice(0, 3)) add(r.assetId, `${product.name} (${r.view})`);
    }
    if (brand.logoAssetId) {
      add(brand.logoAssetId, `${brand.name} logo`);
      brandLines.push('Finish with the brand logo shown (logo end card).');
    }
  }
  for (const a of input.referenceAssetIds) add(a);

  const idea = [
    cartoonIdea(input, cast.map((c) => ({ name: c.name, description: [c.description, Object.values(c.appearance ?? {}).filter(Boolean).join(', '), c.clothing && `wearing ${c.clothing}`].filter(Boolean).join('; ') }))),
    ...brandLines.filter(Boolean),
    references.length ? `Reference photos: ${references.map((r) => `${r.token}${r.note ? ` = ${r.note}` : ''}`).join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000);

  return createMovie(
    ctx,
    user,
    {
      idea,
      lengthSec: input.lengthSec,
      aspectRatio: input.aspectRatio,
      quality: 'balanced',
      style: input.style,
      genre: 'animated cartoon',
      language: input.language,
      withDialogue: input.voices !== 'none',
      withMusic: true,
      keyframes: true,
      lipSync: input.voices === 'dialogue',
      mode: 'director',
      references,
    },
    idempotencyKey,
    { kind: 'movie', settings: { cartoon: { style: input.style, audience: input.audience, voices: input.voices, characterIds: input.characterIds, brandId: input.brandId ?? null, productId: input.productId ?? null } } },
  );
}
