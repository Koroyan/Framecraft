import type { AspectRatio } from './constants';

/*
 * "What do you want to make?" → which flow fits, with the format and length it implies. Runs on
 * the device (free, instant); the user always sees the suggestion and confirms it. English,
 * Georgian and Russian keywords.
 */

export type CreateFlow = 'ai' | 'animate' | 'edit' | 'ad' | 'film';

export type CreateIntent = {
  flow: CreateFlow;
  aspect?: AspectRatio;
  durationSec?: number;
  style?: string;
  /** Plain-language reasons shown next to the suggestion. */
  reasons: string[];
};

const RX = {
  ad: /(\bads?\b|advert|commercial|promo|product|brand|sale|shop|store|რეკლამ|პროდუქტ|ბრენდ|აქცი|მაღაზი|реклам|продукт|бренд|акци|магазин)/,
  film: /(film|movie|story|short film|episode|scene|character|ფილმ|ისტორი|მოთხრობ|სცენ|პერსონაჟ|фильм|истори|сюжет|сцен|персонаж)/,
  animate: /(animate|bring .* to life|this (photo|picture|image)|my (photo|picture|image)|from (a|my|this) (photo|picture|image)|გააცოცხლე|ფოტო|სურათ|оживи|фото|картинк|изображени)/,
  edit: /(edit my|my (video|footage|clip)|trim|cut (my|the) video|my own|footage|montage|ჩემი ვიდეო|ჩემ ვიდეო|დამონტაჟ|მონტაჟ|გავჭრა|моё видео|мое видео|монтаж|обрежь|смонтируй)/,
  vertical: /(vertical|portrait|tiktok|reels?|shorts|stories|story format|9:16|ვერტიკალ|тикток|вертикальн|сторис)/,
  wide: /(youtube(?! shorts)|landscape|horizontal|widescreen|16:9|ჰორიზონტალ|горизонтальн|ютуб)/,
  square: /(square|1:1|კვადრატ|квадрат)/,
  feed: /(4:5|instagram feed|feed post)/,
  cinematic: /(cinematic|film look|კინემატოგრაფ|кинематограф)/,
  luxury: /(premium|luxur|elegant|პრემიუმ|ლუქს|элегант|премиум)/,
  energetic: /(energetic|dynamic|fast|punchy|ენერგი|დინამიკ|динамичн|энергичн)/,
};

/** Length in seconds mentioned in the text ("20-second", "20 s", "30 წამი", "15 сек", "1 minute"). */
export function durationIn(text: string): number | undefined {
  const s = text.toLowerCase();
  const m = s.match(/(\d{1,3})\s*-?\s*(seconds?|secs?|s\b|წამ|сек)/);
  if (m) return Math.min(600, Math.max(3, Number(m[1])));
  const min = s.match(/(\d{1,2}|one|a)\s*-?\s*(minutes?|min\b|წუთ|минут)/);
  if (min) return Math.min(600, (min[1] === 'one' || min[1] === 'a' ? 1 : Number(min[1])) * 60);
  return undefined;
}

export function guessIntent(text: string): CreateIntent | null {
  const s = ` ${text.trim().toLowerCase()} `;
  if (s.trim().length < 3) return null;
  const reasons: string[] = [];
  let flow: CreateFlow = 'ai';
  if (RX.edit.test(s)) {
    flow = 'edit';
    reasons.push('you want to edit your own footage');
  } else if (RX.animate.test(s) && !RX.film.test(s)) {
    flow = 'animate';
    reasons.push('you want to bring an image to life');
  } else if (RX.ad.test(s)) {
    flow = 'ad';
    reasons.push('it is about a product or brand');
  } else if (RX.film.test(s)) {
    flow = 'film';
    reasons.push('it tells a story with scenes');
  } else reasons.push('a single AI-generated video fits best');

  let aspect: AspectRatio | undefined;
  if (RX.vertical.test(s)) aspect = '9:16';
  else if (RX.wide.test(s)) aspect = '16:9';
  else if (RX.square.test(s)) aspect = '1:1';
  else if (RX.feed.test(s)) aspect = '4:5';
  else aspect = flow === 'film' ? '16:9' : '9:16';
  reasons.push(aspect === '9:16' ? 'vertical (TikTok, Reels, Shorts)' : aspect === '16:9' ? 'landscape (YouTube)' : aspect === '1:1' ? 'square' : '4:5 feed');

  const durationSec = durationIn(s) ?? (flow === 'ad' ? 20 : flow === 'film' ? 60 : flow === 'ai' || flow === 'animate' ? 8 : undefined);
  if (durationSec) reasons.push(`${durationSec} s`);
  const style = RX.cinematic.test(s) ? 'cinematic' : RX.luxury.test(s) ? 'luxury' : RX.energetic.test(s) ? 'energetic' : undefined;
  if (style) reasons.push(`${style} style`);
  return { flow, aspect, durationSec, style, reasons };
}
