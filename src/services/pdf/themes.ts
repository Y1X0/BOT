/** Document themes — one per document type. Easy to extend: add an entry. */

export interface Theme {
  id: string;
  font: 'Cairo' | 'Amiri';
  accent: string;
  accent2: string;
  cover: boolean;
  toc: boolean;
  pageNumbers: boolean;
  bodySize: string;
  extraCss: string;
}

const BASE: Omit<Theme, 'id'> = {
  font: 'Cairo',
  accent: '#2c3e70',
  accent2: '#5b6bb0',
  cover: false,
  toc: false,
  pageNumbers: true,
  bodySize: '13pt',
  extraCss: '',
};

export const THEMES: Record<string, Theme> = {
  academic: { ...BASE, id: 'academic', font: 'Amiri', accent: '#1f3a5f', accent2: '#3d6ea5', cover: true, toc: true, bodySize: '14pt' },
  report: {
    ...BASE, id: 'report', font: 'Cairo', accent: '#0f766e', accent2: '#14b8a6', cover: true, toc: true,
    extraCss: 'table th{background:var(--accent);color:#fff} .note{background:#f0fdfa;border-inline-start:4px solid var(--accent2)}',
  },
  assignment: { ...BASE, id: 'assignment', font: 'Cairo', accent: '#4338ca', accent2: '#818cf8', cover: true, toc: false },
  summary: {
    ...BASE, id: 'summary', font: 'Cairo', accent: '#b45309', accent2: '#f59e0b', cover: false, toc: false, pageNumbers: false,
    extraCss: 'strong{background:#fef3c7;padding:0 3px;border-radius:3px} h2{border-inline-start:5px solid var(--accent2);padding-inline-start:10px}',
  },
  cv: {
    ...BASE, id: 'cv', font: 'Cairo', accent: '#0e7490', accent2: '#06b6d4', cover: false, toc: false, pageNumbers: false, bodySize: '12pt',
    extraCss: 'h1{border-bottom:3px solid var(--accent)} h2{color:var(--accent);text-transform:none}',
  },
  book: {
    ...BASE, id: 'book', font: 'Amiri', accent: '#3b2f2f', accent2: '#8b5e34', cover: true, toc: true, bodySize: '14pt',
    extraCss: 'h1{page-break-before:always;text-align:center;margin-top:30mm} p{text-indent:1.5em}',
  },
  memo: { ...BASE, id: 'memo', font: 'Cairo', accent: '#334155', accent2: '#64748b', cover: false, toc: false },
  notes: { ...BASE, id: 'notes', font: 'Cairo', accent: '#7c3aed', accent2: '#a78bfa', cover: false, toc: false, pageNumbers: false },
  plain: { ...BASE, id: 'plain' },
};

/** Document-type picker entries (Arabic label → theme id). */
export const DOC_TYPES: { key: string; label: string; theme: string }[] = [
  { key: 'academic', label: 'بحث جامعي', theme: 'academic' },
  { key: 'report', label: 'تقرير', theme: 'report' },
  { key: 'assignment', label: 'واجب', theme: 'assignment' },
  { key: 'summary', label: 'ملخص', theme: 'summary' },
  { key: 'cv', label: 'سيرة ذاتية', theme: 'cv' },
  { key: 'book', label: 'كتاب', theme: 'book' },
  { key: 'memo', label: 'مذكرة', theme: 'memo' },
  { key: 'notes', label: 'ملاحظات', theme: 'notes' },
  { key: 'plain', label: 'مستند عادي', theme: 'plain' },
];

export function themeForKey(key: string): Theme {
  const entry = DOC_TYPES.find((d) => d.key === key);
  return THEMES[entry?.theme ?? 'plain'] ?? THEMES.plain;
}

export function labelForKey(key: string): string | undefined {
  return DOC_TYPES.find((d) => d.key === key)?.label;
}
