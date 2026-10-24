/**
 * Lightweight, deterministic analysis of a generation request.
 *
 * It only flags requirement signals (people, multiple characters, fast motion,
 * dialogue...). It never claims to judge visual quality. The LLM director can
 * supply a richer analysis; this is the always-available baseline.
 */
export type PromptAnalysis = {
  humans: boolean;
  multipleCharacters: boolean;
  fastAction: boolean;
  complexCamera: boolean;
  textInScene: boolean;
  dialogue: boolean;
  wordCount: number;
  complexity: 'low' | 'medium' | 'high';
  signals: string[];
};

const HUMAN = /\b(person|people|man|men|woman|women|girl|boy|child|kid|kids|baby|lady|guy|face|faces|portrait|model|dancer|actor|actress|detective|chef|soldier|athlete|influencer|he|she|they|his|her|human|crowd|couple|family|friends|character|человек|девушка|мужчина|женщина|ребенок|ადამიანი|ქალი|კაცი)\b/i;
const MULTI = /\b(two|three|four|several|many|group|crowd|couple|friends|family|team|together|duo|both|band|audience|двое|трое|группа|толпа)\b/i;
const ACTION = /\b(run|running|runs|chase|chasing|fight|fighting|explosion|explodes|dance|dancing|racing|race|jump|jumping|sprint|crash|battle|skate|skating|surf|surfing|parkour|backflip|kick|punch|fast|speeding|drift|drifting|бег|погоня|драка|танец|прыжок)\b/i;
const CAMERA = /\b(orbit|orbiting|tracking|crane|drone|aerial|dolly|fpv|whip pan|one take|single take|continuous shot|360)\b/i;
const TEXT = /\b(sign|logo|text|title|caption|lettering|headline|written|words|typography|label|надпись|логотип)\b/i;
const DIALOGUE = /("[^"]{3,}")|(«[^»]{3,}»)|(\b(says|said|speaks|speaking|talks|talking|dialogue|asks|replies|whispers|shouts|sings|singing|говорит|сказал)\b)/i;

export function analyzePrompt(prompt: string, opts: { characterCount?: number; referenceCount?: number } = {}): PromptAnalysis {
  const text = prompt || '';
  const humans = HUMAN.test(text) || (opts.characterCount ?? 0) > 0;
  const multipleCharacters = (opts.characterCount ?? 0) > 1 || (humans && MULTI.test(text));
  const fastAction = ACTION.test(text);
  const complexCamera = CAMERA.test(text);
  const textInScene = TEXT.test(text);
  const dialogue = DIALOGUE.test(text);
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;

  const signals: string[] = [];
  if (humans) signals.push('people on screen');
  if (multipleCharacters) signals.push('multiple characters');
  if (fastAction) signals.push('fast action');
  if (complexCamera) signals.push('complex camera move');
  if (textInScene) signals.push('text in scene');
  if (dialogue) signals.push('dialogue');

  let score = 0;
  if (humans) score += 1;
  if (multipleCharacters) score += 1;
  if (fastAction) score += 1;
  if (complexCamera) score += 1;
  if (dialogue) score += 1;
  if (wordCount > 60) score += 1;
  const complexity = score >= 3 ? 'high' : score >= 1 ? 'medium' : 'low';

  return { humans, multipleCharacters, fastAction, complexCamera, textInScene, dialogue, wordCount, complexity, signals };
}
