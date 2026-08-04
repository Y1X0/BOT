import { describe, it, expect } from 'vitest';
import { parseContent, inline, tableOfContents, type Block } from '../src/services/pdf/parse';
import { themeForKey, labelForKey } from '../src/services/pdf/themes';
import { parseCoverFields } from '../src/plugins/pdf/state';

describe('inline formatting', () => {
  it('escapes HTML then applies bold/italic/code', () => {
    expect(inline('a < b **bold** *it* `c`')).toBe('a &lt; b <strong>bold</strong> <em>it</em> <code>c</code>');
  });
});

describe('parseContent', () => {
  it('detects markdown headings at three levels', () => {
    const b = parseContent('# One\n## Two\n### Three');
    expect(b.map((x) => x.t)).toEqual(['h1', 'h2', 'h3']);
    expect((b[0] as { text: string }).text).toBe('One');
  });

  it('groups bullet and ordered lists', () => {
    const b = parseContent('- a\n- b\n\n1. x\n2. y');
    expect(b[0]).toMatchObject({ t: 'ul', items: ['a', 'b'] });
    expect(b[1]).toMatchObject({ t: 'ol', items: ['x', 'y'] });
  });

  it('parses a pipe table with a header separator', () => {
    const b = parseContent('| A | B |\n| --- | --- |\n| 1 | 2 |');
    const t = b.find((x) => x.t === 'table') as Extract<Block, { t: 'table' }>;
    expect(t).toBeTruthy();
    expect(t.header).toBe(true);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0]).toEqual(['A', 'B']);
  });

  it('collects a references section into a refs block', () => {
    const b = parseContent('المراجع\n- ref one\n- ref two');
    expect(b.some((x) => x.t === 'refs')).toBe(true);
    const refs = b.find((x) => x.t === 'refs') as Extract<Block, { t: 'refs' }>;
    expect(refs.items).toHaveLength(2);
  });

  it('merges wrapped lines into one paragraph', () => {
    const b = parseContent('هذا سطر\nوهذا تكملته في فقرة واحدة طويلة جداً لكي لا تعتبر عنواناً.');
    expect(b).toHaveLength(1);
    expect(b[0].t).toBe('p');
  });

  it('treats a short standalone line as a heading', () => {
    const b = parseContent('المقدمة\nنص الفقرة الأولى الطويل الذي يوضح المحتوى بشكل مفصل.');
    expect(b[0].t).toBe('h2');
    expect(b[1].t).toBe('p');
  });

  it('builds a table of contents from h1/h2', () => {
    const b = parseContent('# باب\n## فصل\nنص عادي هنا.');
    const toc = tableOfContents(b);
    expect(toc).toHaveLength(2);
    expect(toc[0].level).toBe(1);
  });
});

describe('themes', () => {
  it('maps known types and falls back to plain', () => {
    expect(themeForKey('academic').id).toBe('academic');
    expect(themeForKey('academic').cover).toBe(true);
    expect(themeForKey('nope').id).toBe('plain');
    expect(labelForKey('report')).toBe('تقرير');
  });
});

describe('parseCoverFields', () => {
  it('parses label:value lines and ignores blanks', () => {
    const f = parseCoverFields('الاسم: محمد\n\nالجامعة: اليرموك\nسطر بدون قيمة');
    expect(f).toEqual([
      { label: 'الاسم', value: 'محمد' },
      { label: 'الجامعة', value: 'اليرموك' },
    ]);
  });
});
