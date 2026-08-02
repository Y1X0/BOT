/** Puzzle data for the new games. Answers accept common Arabic spellings. */

export interface Puzzle {
  clue: string; // emojis or flag
  answers: string[]; // accepted answers (first is the canonical one)
}

export const EMOJI_PUZZLES: Puzzle[] = [
  { clue: '🦁👑', answers: ['الاسد الملك', 'اسد الملك', 'lion king'] },
  { clue: '🕷🧍', answers: ['الرجل العنكبوت', 'سبايدر مان', 'spiderman'] },
  { clue: '❄️👸', answers: ['ملكة الثلج', 'فروزن', 'frozen'] },
  { clue: '🦇🧍', answers: ['باتمان', 'batman'] },
  { clue: '🐟🔍', answers: ['البحث عن نيمو', 'نيمو', 'nemo'] },
  { clue: '⚽🏆', answers: ['كاس العالم', 'المونديال'] },
  { clue: '🍏📱', answers: ['ابل', 'apple', 'ايفون'] },
  { clue: '🌧☔', answers: ['المطر', 'مطر', 'شتاء'] },
  { clue: '📚🎓', answers: ['التخرج', 'الدراسه', 'الجامعه'] },
  { clue: '☕🌙', answers: ['قهوة الليل', 'سهر', 'السهر'] },
  { clue: '🚑🏥', answers: ['المستشفى', 'الاسعاف', 'الطوارئ'] },
  { clue: '🔥🚒', answers: ['الاطفاء', 'رجل الاطفاء', 'حريق'] },
];

export const FLAGS: Puzzle[] = [
  { clue: '🇸🇦', answers: ['السعودية'] },
  { clue: '🇪🇬', answers: ['مصر'] },
  { clue: '🇯🇴', answers: ['الاردن'] },
  { clue: '🇦🇪', answers: ['الامارات'] },
  { clue: '🇶🇦', answers: ['قطر'] },
  { clue: '🇰🇼', answers: ['الكويت'] },
  { clue: '🇮🇶', answers: ['العراق'] },
  { clue: '🇸🇾', answers: ['سوريا'] },
  { clue: '🇱🇧', answers: ['لبنان'] },
  { clue: '🇵🇸', answers: ['فلسطين'] },
  { clue: '🇲🇦', answers: ['المغرب'] },
  { clue: '🇩🇿', answers: ['الجزائر'] },
  { clue: '🇹🇳', answers: ['تونس'] },
  { clue: '🇹🇷', answers: ['تركيا'] },
  { clue: '🇫🇷', answers: ['فرنسا'] },
  { clue: '🇯🇵', answers: ['اليابان'] },
  { clue: '🇧🇷', answers: ['البرازيل'] },
  { clue: '🇩🇪', answers: ['المانيا'] },
  { clue: '🇮🇹', answers: ['ايطاليا'] },
  { clue: '🇬🇧', answers: ['بريطانيا', 'انجلترا'] },
  { clue: '🇺🇸', answers: ['امريكا', 'الولايات المتحده'] },
  { clue: '🇪🇸', answers: ['اسبانيا'] },
];

export const HANGMAN_WORDS = [
  'مدرسة', 'سيارة', 'برمجة', 'تلفون', 'حاسوب', 'قهوة', 'مطبخ', 'كتاب',
  'وردة', 'طائرة', 'حديقة', 'مفتاح', 'نافذة', 'ساعة', 'قلم', 'بحر',
  'جبل', 'مطر', 'شمس', 'قمر', 'نجمة', 'عصفور', 'زهرة', 'مكتبة',
];
