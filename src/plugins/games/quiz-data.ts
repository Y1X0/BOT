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
  { question: 'ما هي عاصمة فرنسا؟', answers: ['باريس', 'paris'] },
  { question: 'كم عدد أيام السنة الميلادية (غير الكبيسة)؟', answers: ['365'] },
  { question: 'ما أكبر محيط في العالم؟', answers: ['الهادي', 'المحيط الهادي', 'الهادئ', 'pacific'] },
  { question: 'من هو مخترع المصباح الكهربائي؟', answers: ['اديسون', 'أديسون', 'توماس اديسون', 'edison'] },
  { question: 'ما هي عاصمة مصر؟', answers: ['القاهرة', 'قاهرة', 'cairo'] },
  { question: 'كم عدد لاعبي فريق كرة القدم في الملعب؟', answers: ['11', 'احد عشر', 'أحد عشر'] },
  { question: 'ما هو أكبر حيوان في العالم؟', answers: ['الحوت الأزرق', 'الحوت', 'حوت ازرق', 'blue whale'] },
  { question: 'ما هي أصغر دولة في العالم؟', answers: ['الفاتيكان', 'الفاتكان', 'vatican'] },
  { question: 'كم لوناً في علم دولة الإمارات؟', answers: ['4', 'اربعة', 'أربعة'] },
  { question: 'ما هو المعدن السائل في درجة حرارة الغرفة؟', answers: ['الزئبق', 'زئبق', 'mercury'] },
  { question: 'ما هي أطول سلسلة جبال في العالم؟', answers: ['الأنديز', 'الانديز', 'andes'] },
  { question: 'ما هو الكوكب الأحمر؟', answers: ['المريخ', 'مريخ', 'mars'] },
  { question: 'كم حاسة للإنسان؟', answers: ['5', 'خمسة', 'خمس'] },
  { question: 'ما هي عاصمة تركيا؟', answers: ['أنقرة', 'انقرة', 'ankara'] },
];
