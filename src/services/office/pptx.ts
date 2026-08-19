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

type Bullet = { text: string; level: number };
interface SlideDef {
  kind: 'section' | 'content' | 'table' | 'image';
  title: string;
  bullets: Bullet[];
  table?: string[][];
  image?: { dataUri: string; caption?: string };
}

const MAX_BULLETS = 6;

/** Split a long prose paragraph into sentence-sized bullets so slides don't end
 * up with one huge block of text. */
function sentences(text: string): string[] {
  const parts = text.split(/(?<=[.؟!…])\s+/).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : [text];
}

/** Group blocks into well-sized slides. Headings open slides; long bullet lists
 * split across continuation slides; headingless prose still gets titled slides. */
function toSlides(blocks: Block[], images: { dataUri: string; caption?: string }[], docTitle: string): SlideDef[] {
  const raw: SlideDef[] = [];
  let cur: SlideDef | null = null;
  const open = (title: string) => {
    cur = { kind: 'content', title, bullets: [] };
    raw.push(cur);
    return cur;
  };
  for (const b of blocks) {
    switch (b.t) {
      case 'h1':
        raw.push({ kind: 'section', title: b.text, bullets: [] });
        cur = null;
        break;
      case 'h2':
        open(b.text);
        break;
      case 'h3':
        (cur ?? open(docTitle)).bullets.push({ text: plain(b.text), level: 0 });
        break;
      case 'p': {
        const txt = plain(b.html);
        const target = cur ?? open(docTitle);
        if (txt.length > 140) for (const s of sentences(txt)) target.bullets.push({ text: s, level: 1 });
        else target.bullets.push({ text: txt, level: 1 });
        break;
      }
      case 'ul':
      case 'ol':
      case 'refs':
        for (const it of b.items) (cur ?? open(docTitle)).bullets.push({ text: plain(it), level: 1 });
        break;
      case 'quote':
        (cur ?? open(docTitle)).bullets.push({ text: '“ ' + plain(b.html) + ' ”', level: 1 });
        break;
      case 'table':
        raw.push({ kind: 'table', title: (cur as SlideDef | null)?.title ?? docTitle, bullets: [], table: b.rows.map((r) => r.map(plain)) });
        cur = null;
        break;
      case 'hr':
        cur = null;
        break;
      case 'image':
        break;
    }
  }
  for (const img of images) raw.push({ kind: 'image', title: '', bullets: [], image: img });

  // Split content slides that carry too many bullets into readable chunks.
  const out: SlideDef[] = [];
  for (const s of raw) {
    if (s.kind !== 'content' || s.bullets.length <= MAX_BULLETS) {
      out.push(s);
      continue;
    }
    for (let i = 0; i < s.bullets.length; i += MAX_BULLETS) {
      out.push({ kind: 'content', title: i === 0 ? s.title : `${s.title} (تابع)`, bullets: s.bullets.slice(i, i + MAX_BULLETS) });
    }
  }
  return out.length ? out : [{ kind: 'content', title: docTitle, bullets: [{ text: '—', level: 1 }] }];
}

/** Build a styled PowerPoint (.pptx) from the same content the PDF uses. */
export async function createPptx(req: DocRequest): Promise<Buffer> {
  const theme: Theme = themeForKey(req.typeKey);
  const accent = theme.accent.replace('#', '');
  const accent2 = theme.accent2.replace('#', '');
  const INK = '2A2E39';
  const MUTED = '9AA0AD';
  const LIGHT = 'F4F6FB';

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'W', width: 13.33, height: 7.5 });
  pptx.layout = 'W';
  pptx.rtlMode = true;

  const FONT = 'Arial';
  const titleOpt = { fontFace: FONT, rtlMode: true, align: 'right' as const };

  // ---- Title slide ----
  const t = pptx.addSlide();
  t.background = { color: accent };
  t.addShape('rect', { x: 0, y: 0, w: '100%', h: '100%', fill: { color: accent } });
  t.addShape('rect', { x: 0.9, y: 3.55, w: 3.2, h: 0.09, fill: { color: 'FFFFFF' } });
  t.addText(req.title || 'عرض تقديمي', { x: 0.9, y: 2.2, w: 11.5, h: 1.3, align: 'center', rtlMode: true, fontSize: 44, bold: true, color: 'FFFFFF', fontFace: FONT });
  const sub = [req.customType, ...req.cover.filter((f) => f.value.trim()).map((f) => `${f.label}: ${f.value}`), req.date].filter(Boolean).join('    •    ');
  if (sub) t.addText(sub, { x: 0.9, y: 3.8, w: 11.5, h: 0.9, align: 'center', rtlMode: true, fontSize: 16, color: 'EAF0FF', fontFace: FONT });

  const slides = toSlides(parseContent(req.content || ''), req.images, req.title || 'عرض');
  let pageNo = 1;
  for (const s of slides) {
    const slide = pptx.addSlide();
    pageNo++;

    if (s.kind === 'section') {
      // Divider slide: full accent background, big centered title.
      slide.background = { color: accent };
      slide.addShape('rect', { x: 4.9, y: 4.55, w: 3.5, h: 0.07, fill: { color: 'FFFFFF' } });
      slide.addText(s.title, { x: 0.8, y: 2.9, w: 11.7, h: 1.6, align: 'center', rtlMode: true, fontSize: 34, bold: true, color: 'FFFFFF', fontFace: FONT });
      continue;
    }

    slide.background = { color: 'FFFFFF' };
    // Top accent strip + title + underline.
    slide.addShape('rect', { x: 0, y: 0, w: '100%', h: 0.22, fill: { color: accent } });
    if (s.title) {
      slide.addText(s.title, { x: 0.6, y: 0.5, w: 12.1, h: 0.8, ...titleOpt, fontSize: 27, bold: true, color: accent });
      slide.addShape('rect', { x: 0.6, y: 1.35, w: 12.1, h: 0.035, fill: { color: accent2 } });
    }
    // Footer.
    slide.addText(req.title || '', { x: 0.6, y: 7.02, w: 9, h: 0.35, align: 'right', rtlMode: true, fontSize: 10, color: MUTED, fontFace: FONT });
    slide.addText(String(pageNo - 1), { x: 12.3, y: 7.02, w: 0.5, h: 0.35, align: 'center', fontSize: 10, color: MUTED, fontFace: FONT });

    if (s.kind === 'image' && s.image) {
      slide.addImage({ data: s.image.dataUri, x: 1.4, y: 1.0, w: 10.5, h: 5.4, sizing: { type: 'contain', w: 10.5, h: 5.4 } });
      if (s.image.caption) slide.addText(s.image.caption, { x: 0.6, y: 6.5, w: 12.1, h: 0.4, align: 'center', rtlMode: true, fontSize: 12, italic: true, color: MUTED, fontFace: FONT });
    } else if (s.kind === 'table' && s.table) {
      const rows = s.table.map((r, ri) =>
        r.map((c) => ({
          text: c,
          options: {
            fontSize: 14,
            align: 'right' as const,
            rtlMode: true,
            valign: 'middle' as const,
            color: ri === 0 ? 'FFFFFF' : INK,
            bold: ri === 0,
            fill: { color: ri === 0 ? accent : ri % 2 ? LIGHT : 'FFFFFF' },
            margin: 4,
          },
        })),
      );
      slide.addTable(rows, { x: 0.7, y: 1.7, w: 11.9, border: { type: 'solid', pt: 1, color: 'E4E7F0' }, autoPage: false, valign: 'middle' });
    } else if (s.bullets.length) {
      slide.addText(
        s.bullets.map((b) => ({
          text: b.text,
          options: {
            bullet: b.level === 0 ? { code: '25AA' } : { code: '2022', indent: 18 },
            indentLevel: b.level,
            fontSize: b.level === 0 ? 20 : 16,
            bold: b.level === 0,
            color: b.level === 0 ? accent : INK,
            paraSpaceAfter: 12,
            lineSpacingMultiple: 1.05,
            rtlMode: true,
            align: 'right' as const,
          },
        })),
        { x: 0.7, y: 1.6, w: 11.9, h: 5.1, valign: 'top', fontFace: FONT },
      );
    }
  }

  const out = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  return Buffer.from(out);
}
