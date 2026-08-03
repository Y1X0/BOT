/** Emoji puzzles for the media-guessing game. Each has a clue + accepted answers. */
export interface MediaPuzzle {
  clue: string;
  answers: string[]; // first entry is the "official" answer shown on reveal
}

export const MOVIES: MediaPuzzle[] = [
  { clue: '🦁👑', answers: ['الاسد الملك', 'الأسد الملك', 'lion king'] },
  { clue: '🕷️👨🕸️', answers: ['سبايدر مان', 'الرجل العنكبوت', 'spiderman', 'spider man'] },
  { clue: '🚢🧊💔', answers: ['تايتانيك', 'titanic'] },
  { clue: '🐠🔍👨‍👦', answers: ['البحث عن نيمو', 'نيمو', 'finding nemo'] },
  { clue: '🤖❤️🌱', answers: ['وول-e', 'وول اي', 'wall-e', 'wall e'] },
  { clue: '🦖🏝️🧬', answers: ['الحديقة الجوراسية', 'حديقة الديناصورات', 'jurassic park'] },
  { clue: '🧙‍♂️⚡🤓', answers: ['هاري بوتر', 'harry potter'] },
  { clue: '💍🌋🧝', answers: ['سيد الخواتم', 'lord of the rings'] },
  { clue: '❄️👸⛄', answers: ['فروزن', 'ملكة الثلج', 'frozen'] },
  { clue: '🚗⚡🏁', answers: ['سيارات', 'cars'] },
  { clue: '🐭🍳👨‍🍳', answers: ['راتاتوي', 'ratatouille'] },
  { clue: '🦇🦸‍♂️🌃', answers: ['باتمان', 'batman'] },
  { clue: '🟢👹🧅', answers: ['شريك', 'shrek'] },
  { clue: '🐼🥋🍜', answers: ['كونغ فو باندا', 'الباندا المقاتل', 'kung fu panda'] },
  { clue: '👽📞🏠', answers: ['اي تي', 'إي تي', 'e.t.', 'et'] },
  { clue: '🧠💭🎭', answers: ['قلبا وقالبا', 'inside out'] },
  { clue: '🦣❄️🐿️', answers: ['العصر الجليدي', 'ice age'] },
  { clue: '🏴‍☠️🌊⚓', answers: ['قراصنة الكاريبي', 'pirates of the caribbean', 'قراصنة'] },
  { clue: '🤠🚀🧸', answers: ['حكاية لعبة', 'toy story'] },
  { clue: '🐝🎬🍯', answers: ['فيلم النحلة', 'bee movie'] },
  { clue: '🦸‍♂️🦸‍♀️👨‍👩‍👧‍👦', answers: ['العائلة الخارقة', 'incredibles'] },
  { clue: '🌊🔱🧜‍♀️', answers: ['حورية البحر', 'الحورية الصغيرة', 'little mermaid'] },
];

export const SONGS: MediaPuzzle[] = [
  { clue: '👶🦈🎵', answers: ['بيبي شارك', 'baby shark'] },
  { clue: '🕺🎩🌙 (مايكل جاكسون)', answers: ['بيلي جين', 'billie jean'] },
  { clue: '🇰🇷🐴💃', answers: ['جانجنام ستايل', 'gangnam style'] },
  { clue: '❄️🙅‍♀️🎶 (من فروزن)', answers: ['let it go', 'ليت ات جو'] },
  { clue: '☂️🌧️ (ريهانا)', answers: ['umbrella', 'امبريلا'] },
  { clue: '👏😃🎵 (فاريل)', answers: ['happy', 'هابي'] },
  { clue: '🐒💃🎶', answers: ['dance monkey', 'دانس مانكي'] },
  { clue: '🌟⭐👶', answers: ['twinkle twinkle', 'نجمة'] },
  { clue: '🎄🔔🛷', answers: ['jingle bells', 'اجراس'] },
  { clue: '🕯️🌬️ (إلتون جون)', answers: ['candle in the wind', 'شمعة في الريح'] },
];
