import type { PlanOp } from './edit';
import { COLOR_WORDS } from './objects';

/*
 * Instant answers for common editing requests (English, Georgian, Russian): understood on the
 * device, free, no AI call. Anything unclear, long, conditional or time-specific returns null and
 * goes to the AI planner instead — this parser never guesses.
 */

export type QuickContext = {
  clipId?: string;
  clipIndex?: number;
  objectId?: string;
  /** Selected stretch of the movie, timeline seconds. */
  range?: { start: number; end: number };
  playhead?: number;
};

type Lang = 'en' | 'ka' | 'ru';
const langOf = (s: string): Lang => (/[Ⴀ-ჿ]/.test(s) ? 'ka' : /[Ѐ-ӿ]/.test(s) ? 'ru' : 'en');

const has = (re: RegExp, s: string) => re.test(s);

const W = {
  music: /(music|song|soundtrack|მუსიკ|музык|песн)/,
  quieter: /(quiet|lower|softer|turn( it)? down|down\b|reduce|less loud|ჩუმ|დაუწიე|შეამცირე|დაბლა|тише|потише|убав|уменьш)/,
  louder: /(loud|turn( it)? up|\bup\b|raise|increase|ხმამაღლა|აუწიე|გაზარდე|громче|прибав|увелич)/,
  off: /(mute|\boff\b|silence|without music|remove the music|გათიშე|ამოიღე|без музык|выключ|убери)/,
  original: /(original|clip|camera|ორიგინალ|კლიპის|оригинал|клип)/,
  sound: /(audio|sound|ხმა|звук)/,
  brighter: /(bright|lighter|lighten|გაანათე|უფრო ნათელ|ნათელი გახადე|ярче|светлее|освет)/,
  darker: /(dark|გაამუქე|ჩაამუქე|დაამუქე|მუქი გახადე|უფრო მუქ|темнее|затемн)/,
  warmer: /(warm|თბილ|теплее|тепл)/,
  cooler: /(cool|cold|ცივ|холод)/,
  saturated: /(saturat|vivid|colou?rful|vibrant|ფერად|გაჯერებ|насыщ)/,
  desaturated: /(desaturat|muted colou?r|less colou?r|ნაკლებად ფერად|приглуш)/,
  contrast: /(contrast|კონტრასტ|контраст)/,
  less: /(less|lower|reduce|softer|ნაკლებ|შეამცირე|меньше|уменьш)/,
  bw: /(black (and|&) white|b&w|b\/w|monochrome|grayscale|greyscale|შავ[- ]?თეთრ|черно-бел|чёрно-бел)/,
  cinematic: /(cinematic|film look|movie look|კინემატოგრაფ|კინოსავით|кинематограф|киношн)/,
  vintage: /(vintage|retro|old film|ვინტაჟ|რეტრო|винтаж|ретро)/,
  premium: /(premium|luxur|elegant|პრემიუმ|ლუქს|ელეგანტ|элегант|премиум|роскош)/,
  moody: /(moody|dramatic|დრამატულ|драмат|мрачн)/,
  faster: /(speed (it )?up|faster|quicker|აჩქარ|უფრო სწრაფ|быстрее|ускор)/,
  slower: /(slow (it )?down|slower|slow motion|slow-mo|შეანელ|უფრო ნელ|медленнее|замедл)/,
  fadeIn: /(fade in|fade-in|ფეიდ ინ|შემოსვლ|появлени|плавное начало)/,
  fadeOut: /(fade out|fade-out|fade to black|fade at the end|end with a fade|ფეიდ აუთ|ჩაქრ|затухан|затемнение в конце)/,
  fade: /(\bfades?\b|ფეიდ|затухани)/,
  transition: /(transition|გადასვლ|переход)/,
  blur: /(blur|დაბლარ|ბუნდოვან|გაბუნდოვან|размой|размыть|размыти|заблюр)/,
  recolor: /(make|turn|change|colou?r|paint|გახადე|გადააკეთე|შეცვალე|შეღებე|ფერ|сделай|покрась|измени|цвет)/,
  cut: /(\bcut\b|remove|delete|drop|trim out|get rid|წაშალე|ამოჭერი|მოაშორე|ამოიღე|удали|вырежи|убери)/,
  part: /(this|part|section|bit|range|selected|selection|boring|ეს|ამ |ნაწილ|მონიშნ|მოსაწყენ|кусок|часть|фрагмент|выделен|скучн)/,
  clipWord: /(clip|shot|კლიპ|კადრ|клип|кадр)/,
  allWord: /(whole|entire|\ball\b|every|video|movie|\bad\b|advert|მთელ|ყველა|ვიდეო|რეკლამ|ფილმ|весь|всё|все |видео|ролик|фильм)/,
  add: /(add|put|insert|დაამატე|ჩასვი|добавь|вставь)/,
  title: /(title|headline|text|caption|სათაური|წარწერ|ტექსტ|заголовок|титр|текст|надпис)/,
  logo: /(logo|ლოგო|логотип|лого)/,
  end: /(\bend\b|ending|finish|ბოლო|конц|финал)/,
};

const REPLY: Record<Lang, { ready: (n: number) => string; needObject: string; needRange: string }> = {
  en: {
    ready: (n) => `Ready: ${n} change${n === 1 ? '' : 's'} — free and instant. Preview or apply below; Ctrl+Z undoes it.`,
    needObject: 'Click the object in the preview first (it gets an outline), then ask again — I’ll change only that object.',
    needRange: 'Select the part first: drag on the time ruler (or press I and O), then ask again.',
  },
  ka: {
    ready: (n) => `მზადაა: ${n} ცვლილება — უფასო და მყისიერი. ნახე ან გამოიყენე ქვემოთ; Ctrl+Z აუქმებს.`,
    needObject: 'ჯერ დააჭირე ობიექტს ვიდეოში (გამოიკვეთება), მერე ისევ მთხოვე — შევცვლი მხოლოდ მას.',
    needRange: 'ჯერ მონიშნე ნაწილი: გადაათრიე დროის სახაზავზე (ან დააჭირე I და O), მერე ისევ მთხოვე.',
  },
  ru: {
    ready: (n) => `Готово: ${n} изм. — бесплатно и мгновенно. Посмотрите или примените ниже; Ctrl+Z отменяет.`,
    needObject: 'Сначала нажмите на объект в превью (появится контур), затем повторите запрос — изменю только его.',
    needRange: 'Сначала выделите фрагмент: протяните по линейке времени (или нажмите I и O), затем повторите.',
  },
};

/** The colour asked for, if any ("make it blue", "ლურჯი გახადე", "сделай синим"). */
function colorIn(s: string): string | null {
  for (const [word, hex] of Object.entries(COLOR_WORDS)) {
    if (/^[a-z]+$/.test(word)) {
      if (new RegExp(`\\b${word}\\b`).test(s)) return hex; // "reduce" is not red
      continue;
    }
    // Georgian adjectives change their ending (ლურჯი → ლურჯად), Russian ones too (синий → синим).
    const stem = /[Ⴀ-ჿ]/.test(word) ? word.replace(/ი$/, '') : word.length >= 5 ? word.slice(0, -2) : word;
    if (s.includes(stem)) return hex;
  }
  return null;
}

export function quickPlan(message: string, ctx: QuickContext): { reply: string; ops: PlanOp[] } | null {
  const raw = message.trim();
  if (!raw || raw.length > 160 || raw.includes('?')) return null;
  const quoted = raw.match(/["“”«»„'‘’](.+?)["“”«»'‘’]/)?.[1]?.trim();
  const s = ` ${raw.replace(/["“”«»„'‘’].+?["“”«»'‘’]/, ' ').toLowerCase()} `;
  // Conditions, exceptions or explicit times need real understanding → AI planner.
  if (/\d/.test(s) || /(except|unless|only when|\bif\b|but |მაგრამ|გარდა|თუ |кроме|если|но )/.test(s)) return null;
  const lang = langOf(raw);
  const text = REPLY[lang];
  const ops: PlanOp[] = [];
  const target: 'object' | 'clip' | 'all' = has(W.allWord, s) ? 'all' : ctx.objectId && !has(W.clipWord, s) ? 'object' : ctx.clipId ? 'clip' : 'all';
  const clipIds = target === 'clip' && ctx.clipId ? [ctx.clipId] : [];
  const adjust = (delta: Record<string, number>) => {
    if (target === 'object' && ctx.objectId && ctx.clipId) ops.push({ op: 'object_adjust', clipId: ctx.clipId, objectId: ctx.objectId, delta });
    else ops.push({ op: 'clip_adjust', clipIds, delta });
  };

  // Audio
  if (has(W.music, s)) {
    if (has(W.off, s)) ops.push({ op: 'volume', target: 'music', factor: 0 });
    else if (has(W.quieter, s)) ops.push({ op: 'volume', target: 'music', factor: 0.6 });
    else if (has(W.louder, s)) ops.push({ op: 'volume', target: 'music', factor: 1.4 });
  } else if (has(W.original, s) && has(W.sound, s) && has(W.off, s)) ops.push({ op: 'mute_original', muted: true });

  // Cut the selected stretch (ripple)
  const wantsCut = has(W.cut, s) && has(W.part, s) && !has(W.music, s) && !has(W.logo, s);
  if (wantsCut && ctx.range && ctx.range.end - ctx.range.start >= 0.05) ops.push({ op: 'cut_range', startSec: ctx.range.start, endSec: ctx.range.end });
  else if (wantsCut && !ctx.range && !has(W.clipWord, s) && !ctx.objectId) return { reply: text.needRange, ops: [] };
  else if (has(W.cut, s) && has(W.clipWord, s) && ctx.clipId && !ctx.range) ops.push({ op: 'remove_clip', clipId: ctx.clipId });

  // Looks: the whole video unless the request points at the clip ("this clip", "this shot").
  const lookIds = ctx.clipId && has(W.clipWord, s) && !has(W.allWord, s) ? [ctx.clipId] : [];
  if (has(W.bw, s)) ops.push({ op: 'look', clipIds: lookIds, key: 'bw' });
  else if (has(W.cinematic, s)) ops.push({ op: 'look', clipIds: lookIds, key: 'cinematic' });
  else if (has(W.vintage, s)) ops.push({ op: 'look', clipIds: lookIds, key: 'vintage' });
  else if (has(W.premium, s)) ops.push({ op: 'look', clipIds: lookIds, key: 'luxury' });
  else if (has(W.moody, s)) ops.push({ op: 'look', clipIds: lookIds, key: 'moody' });

  // Object: recolour / blur (need a selected object)
  const color = has(W.bw, s) ? null : colorIn(s); // "black and white" is a look, not a colour
  const wantsBlur = has(W.blur, s);
  if ((wantsBlur || (color && has(W.recolor, s) && !has(W.title, s))) && !ctx.objectId) return { reply: text.needObject, ops: [] };
  if (ctx.objectId && ctx.clipId) {
    if (wantsBlur) ops.push({ op: 'object_blur', clipId: ctx.clipId, objectId: ctx.objectId, amount: 16 });
    if (color && has(W.recolor, s)) ops.push({ op: 'object_recolor', clipId: ctx.clipId, objectId: ctx.objectId, to: color });
  }

  // Light and colour
  if (!has(W.music, s) && !has(W.bw, s)) {
    if (has(W.brighter, s)) adjust({ exposure: 0.3 });
    else if (has(W.darker, s)) adjust({ exposure: -0.3 });
    if (has(W.warmer, s)) adjust({ temperature: 0.2 });
    else if (has(W.cooler, s)) adjust({ temperature: -0.2 });
    if (has(W.desaturated, s)) adjust({ saturation: -0.25 });
    else if (has(W.saturated, s)) adjust({ saturation: 0.2 });
    if (has(W.contrast, s)) adjust({ contrast: has(W.less, s) ? -0.15 : 0.15 });
  }

  // Speed
  if (has(W.faster, s)) ops.push({ op: 'clip_speed', clipIds, factor: 1.5 });
  else if (has(W.slower, s)) ops.push({ op: 'clip_speed', clipIds, factor: 0.5 });

  // Fades and transitions
  if (has(W.transition, s)) ops.push({ op: 'transitions_all', clipIds, type: has(W.fade, s) ? 'fade' : /(black|შავ|черн)/.test(s) ? 'fadeblack' : /(wipe|slide)/.test(s) ? 'wipeleft' : 'dissolve', durationSec: 0.5 });
  else if (has(W.fadeIn, s) || has(W.fadeOut, s)) ops.push({ op: 'edge_fade', ...(has(W.fadeIn, s) ? { inSec: 0.8 } : {}), ...(has(W.fadeOut, s) ? { outSec: 1.2 } : {}) });
  else if (has(W.fade, s) && has(W.add, s)) ops.push({ op: 'edge_fade', inSec: 0.8, outSec: 1.2 });

  // Title with quoted text, logo at the end
  if (has(W.add, s) && has(W.title, s) && quoted) {
    const at = Math.max(0, Math.round((ctx.playhead ?? 0) * 10) / 10);
    ops.push({ op: 'title', text: quoted.slice(0, 200), startSec: at, endSec: at + 3, position: 'top' });
  }
  if (has(W.logo, s) && has(W.end, s)) ops.push({ op: 'logo', position: 'bottom-right', lastSec: 3 });

  if (!ops.length) return null;
  return { reply: text.ready(ops.length), ops };
}
