import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ImageRun,
} from 'docx';
import sharp from 'sharp';
import { parseContent, type Block } from '../pdf/parse';
import { themeForKey, type Theme } from '../pdf/themes';

export interface DocRequest {
  title: string;
  typeKey: string;
  customType?: string;
  cover: { label: string; value: string }[];
  content: string;
  images: { dataUri: string; caption?: string }[];
  date?: string;
}

const hx = (c: string) => c.replace('#', '');

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Parse the block's inline HTML (from the shared parser) into styled runs. */
function runs(html: string, base: { bold?: boolean; color?: string; size?: number } = {}): TextRun[] {
  const out: TextRun[] = [];
  let bold = !!base.bold;
  let italic = false;
  const re = /<(\/?)(strong|b|em|i|code|a)(?:\s[^>]*)?>|([^<]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[3] != null) {
      const t = decode(m[3]);
      if (t) out.push(new TextRun({ text: t, bold, italics: italic, rightToLeft: true, color: base.color, size: base.size }));
    } else {
      const closing = m[1] === '/';
      const tag = m[2].toLowerCase();
      if (tag === 'strong' || tag === 'b') bold = !closing;
      else if (tag === 'em' || tag === 'i') italic = !closing;
    }
  }
  if (!out.length) out.push(new TextRun({ text: decode(html.replace(/<[^>]+>/g, '')), bold, rightToLeft: true, color: base.color, size: base.size }));
  return out;
}

function heading(text: string, size: number, color: string, border = false): Paragraph {
  return new Paragraph({
    bidirectional: true,
    alignment: AlignmentType.RIGHT,
    spacing: { before: 240, after: 100 },
    border: border ? { bottom: { style: BorderStyle.SINGLE, size: 12, color, space: 2 } } : undefined,
    children: [new TextRun({ text, bold: true, color, size, rightToLeft: true })],
  });
}

function blockToDocx(b: Block, theme: Theme): (Paragraph | Table)[] {
  const accent = hx(theme.accent);
  const accent2 = hx(theme.accent2);
  switch (b.t) {
    case 'h1':
      return [heading(b.text, 34, accent, true)];
    case 'h2':
      return [heading(b.text, 30, accent)];
    case 'h3':
      return [heading(b.text, 26, accent2)];
    case 'p':
      return [new Paragraph({ bidirectional: true, alignment: AlignmentType.JUSTIFIED, spacing: { after: 140 }, children: runs(b.html) })];
    case 'quote':
      return [
        new Paragraph({
          bidirectional: true,
          alignment: AlignmentType.RIGHT,
          spacing: { after: 140 },
          indent: { start: 360 },
          border: { right: { style: BorderStyle.SINGLE, size: 18, color: accent2, space: 8 } },
          children: runs(b.html, { color: '444444' }),
        }),
      ];
    case 'ul':
      return b.items.map((it) => new Paragraph({ bidirectional: true, alignment: AlignmentType.RIGHT, bullet: { level: 0 }, spacing: { after: 60 }, children: runs(it) }));
    case 'ol':
    case 'refs':
      return b.items.map((it, i) => new Paragraph({ bidirectional: true, alignment: AlignmentType.RIGHT, spacing: { after: 60 }, children: runs(`${i + 1}. ${it}`) }));
    case 'hr':
      return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: accent2, space: 1 } }, spacing: { after: 120 }, children: [] })];
    case 'table': {
      const rows = b.rows.map(
        (r, ri) =>
          new TableRow({
            children: r.map(
              (c) =>
                new TableCell({
                  shading: b.header && ri === 0 ? { fill: accent } : ri % 2 === 1 ? { fill: 'F3F4FA' } : { fill: 'FFFFFF' },
                  children: [
                    new Paragraph({
                      bidirectional: true,
                      alignment: AlignmentType.RIGHT,
                      children: runs(c, b.header && ri === 0 ? { bold: true, color: 'FFFFFF' } : {}),
                    }),
                  ],
                }),
            ),
          }),
      );
      return [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows })];
    }
    case 'image':
      return []; // images handled separately (need async dimensions)
  }
}

async function imageParagraphs(images: { dataUri: string; caption?: string }[]): Promise<Paragraph[]> {
  const out: Paragraph[] = [];
  for (const img of images) {
    const b64 = img.dataUri.split(',')[1] ?? '';
    const buf = Buffer.from(b64, 'base64');
    let w = 480;
    let h = 320;
    try {
      const meta = await sharp(buf).metadata();
      if (meta.width && meta.height) {
        const maxW = 480;
        w = Math.min(maxW, meta.width);
        h = Math.round((w / meta.width) * meta.height);
      }
    } catch {
      /* keep defaults */
    }
    out.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 120, after: 60 },
        children: [new ImageRun({ type: 'jpg', data: buf, transformation: { width: w, height: h } })],
      }),
    );
    if (img.caption) out.push(new Paragraph({ alignment: AlignmentType.CENTER, bidirectional: true, spacing: { after: 140 }, children: [new TextRun({ text: img.caption, italics: true, size: 18, color: '666666', rightToLeft: true })] }));
  }
  return out;
}

/** Build a styled Word (.docx) document from the same content the PDF uses. */
export async function createDocx(req: DocRequest): Promise<Buffer> {
  const theme = themeForKey(req.typeKey);
  const accent = hx(theme.accent);
  const blocks = parseContent(req.content || '');

  const children: (Paragraph | Table)[] = [];
  // Title + cover fields.
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      bidirectional: true,
      spacing: { after: 120 },
      children: [new TextRun({ text: req.title || 'مستند', bold: true, size: 52, color: accent, rightToLeft: true })],
    }),
  );
  if (req.customType || req.date) {
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, bidirectional: true, spacing: { after: 80 }, children: [new TextRun({ text: [req.customType, req.date].filter(Boolean).join(' • '), color: hx(theme.accent2), rightToLeft: true })] }));
  }
  for (const f of req.cover.filter((f) => f.value.trim())) {
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, bidirectional: true, children: [new TextRun({ text: `${f.label}: `, bold: true, color: accent, rightToLeft: true }), new TextRun({ text: f.value, rightToLeft: true })] }));
  }
  children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: accent, space: 4 } }, spacing: { after: 200 }, children: [] }));

  for (const b of blocks) children.push(...blockToDocx(b, theme));
  children.push(...(await imageParagraphs(req.images)));

  const doc = new Document({
    creator: 'Bot',
    title: req.title,
    sections: [{ properties: {}, children }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}
