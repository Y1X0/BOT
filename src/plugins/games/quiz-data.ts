/** Simple culture/trivia quiz bank (Arabic). Extend freely. */
export interface QuizQuestion {
  question: string;
  answers: string[]; // accepted answers (case-insensitive, trimmed)
}

export const QUIZ_QUESTIONS: QuizQuestion[] = [
  { question: 'ما هي عاصمة اليابان؟', answers: ['طوكيو', 'tokyo'] },
  { question: 'كم عدد ألوان قوس قزح؟', answers: ['7', 'سبعة', 'سبع'] },
  { question: 'ما أكبر كوكب في المجموعة الشمسية؟', answers: ['المشتري', 'مشتري', 'jupiter'] },
  { question: 'من كتب رواية "البؤساء"؟', answers: ['فيكتور هوغو', 'فيكتور هيغو', 'victor hugo'] },
  { question: 'ما هو أطول نهر في العالم؟', answers: ['النيل', 'نهر النيل', 'nile'] },
  { question: 'كم عدد قارات العالم؟', answers: ['7', 'سبعة', 'سبع'] },
  { question: 'ما هي عملة اليابان؟', answers: ['ين', 'الين', 'yen'] },
  { question: 'في أي عام هبط الإنسان على القمر؟', answers: ['1969'] },
  { question: 'ما هو أسرع حيوان بري في العالم؟', answers: ['الفهد', 'فهد', 'cheetah'] },
  { question: 'ما هو العنصر الكيميائي الذي رمزه O؟', answers: ['الأكسجين', 'اكسجين', 'أكسجين', 'oxygen'] },
];
