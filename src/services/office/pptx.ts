import PptxGenJS from 'pptxgenjs';
import { parseContent, type Block } from '../pdf/parse';
import { themeForKey, type Theme } from '../pdf/themes';
import type { DocRequest } from './docx';

/** Strip inline HTML → plain text (PowerPoint bullets are plain text). */
function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

interface SlideDef {
  title: string;
  bullets: { text: string; level: number }[];
  table?: string[][];
  image?: { dataUri: string; caption?: string };
}

/** Group the flat block list into slides: a heading opens a new slide; the
 * paragraphs/lists under it become its bullets; tables and images get their
 * own slide. */
function toSlides(blocks: Block[], images: { dataUri: string; caption?: string }[]): SlideDef[] {
  const slides: SlideDef[] = [];
  let cur: SlideDef | null = null;
  const ensure = (title = '') => {
    cur = { title, bullets: [] };
    slides.push(cur);
    return cur;
  };
  for (const b of blocks) {
    switch (b.t) {
      case 'h1':
      case 'h2':
        ensure(b.text);
        break;
      case 'h3':
        if (!cur) ensure();
        cur!.bullets.push({ text: plain(b.text), level: 0 });
        break;
      case 'p':
        if (!cur) ensure();
        cur!.bullets.push({ text: plain(b.html), level: 1 });
        break;
      case 'ul':
      case 'ol':
      case 'refs':
        if (!cur) ensure();
        for (const it of b.items) cur!.bullets.push({ text: plain(it), level: 1 });
        break;
      case 'quote':
        if (!cur) ensure();
        cur!.bullets.push({ text: '❝ ' + plain(b.html), level: 1 });
        break;
      case 'table':
        slides.push({ title: '', bullets: [], table: b.rows.map((r) => r.map(plain)) });
        cur = null;
        break;
      case 'hr':
        cur = null;
        break;
      case 'image':
        break;
    }
  }
  for (const img of images) slides.push({ title: '', bullets: [], image: img });
  // Cap very long bullet lists per slide by splitting (keeps slides readable).
  const out: SlideDef[] = [];
  for (const s of slides) {
    if (s.bullets.length <= 8 || s.table || s.image) {
      out.push(s);
      continue;
    }
    for (let i = 0; i < s.bullets.length; i += 8) {
      out.push({ title: i === 0 ? s.title : s.title + ' (تابع)', bullets: s.bullets.slice(i, i + 8) });
    }
  }
  return out;
}

/** Build a styled PowerPoint (.pptx) from the same content the PDF uses. */
export async function createPptx(req: DocRequest): Promise<Buffer> {
  const theme: Theme = themeForKey(req.typeKey);
  const accent = theme.accent.replace('#', '');
  const accent2 = theme.accent2.replace('#', '');
  const DARK = '0E1116';

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
  pptx.rtlMode = true;

  // Title slide.
  const t = pptx.addSlide();
  t.background = { color: DARK };
  t.addShape('rect', { x: 0, y: 3.0, w: '100%', h: 0.06, fill: { color: accent2 } });
  t.addText(req.title || 'عرض تقديمي', { x: 0.5, y: 2.1, w: 12.3, h: 1.2, align: 'center', rtlMode: true, fontSize: 40, bold: true, color: 'FFFFFF', fontFace: 'Arial' });
  const sub = [req.customType, ...req.cover.filter((f) => f.value.trim()).map((f) => `${f.label}: ${f.value}`), req.date].filter(Boolean).join('   •   ');
  if (sub) t.addText(sub, { x: 0.5, y: 3.3, w: 12.3, h: 0.8, align: 'center', rtlMode: true, fontSize: 15, color: accent2, fontFace: 'Arial' });

  const slides = toSlides(parseContent(req.content || ''), req.images);
  for (const s of slides) {
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    // Accent header band.
    slide.addShape('rect', { x: 0, y: 0, w: '100%', h: 0.9, fill: { color: accent } });
    if (s.title) slide.addText(s.title, { x: 0.4, y: 0.1, w: 12.5, h: 0.7, align: 'right', rtlMode: true, fontSize: 24, bold: true, color: 'FFFFFF', fontFace: 'Arial' });

    if (s.image) {
      const b64 = s.image.dataUri;
      slide.addImage({ data: b64, x: 1.5, y: 1.2, w: 10.3, h: 5.4, sizing: { type: 'contain', w: 10.3, h: 5.4 } });
      if (s.image.caption) slide.addText(s.image.caption, { x: 0.5, y: 6.7, w: 12.3, h: 0.5, align: 'center', rtlMode: true, fontSize: 12, italic: true, color: '666666' });
    } else if (s.table) {
      const rows = s.table.map((r, ri) =>
        r.map((c) => ({
          text: c,
          options: { fontSize: 13, align: 'right' as const, rtlMode: true, color: ri === 0 ? 'FFFFFF' : '222222', bold: ri === 0, fill: { color: ri === 0 ? accent : ri % 2 ? 'F3F4FA' : 'FFFFFF' } },
        })),
      );
      slide.addTable(rows, { x: 0.5, y: 1.2, w: 12.3, border: { type: 'solid', pt: 1, color: 'DDDDDD' }, autoPage: true });
    } else if (s.bullets.length) {
      slide.addText(
        s.bullets.map((b) => ({ text: b.text, options: { bullet: { indent: 15 }, indentLevel: b.level, fontSize: b.level === 0 ? 19 : 16, bold: b.level === 0, color: b.level === 0 ? accent : '222222', paraSpaceAfter: 8, rtlMode: true, align: 'right' as const } })),
        { x: 0.6, y: 1.15, w: 12.1, h: 5.9, valign: 'top', fontFace: 'Arial' },
      );
    }
  }

  const out = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  return Buffer.from(out);
}
