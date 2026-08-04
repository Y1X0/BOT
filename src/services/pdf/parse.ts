/** Pure content parser: raw text / markdown → structured blocks (no I/O). */

export type Block =
  | { t: 'h1' | 'h2' | 'h3'; text: string }
  | { t: 'p'; html: string }
  | { t: 'ul' | 'ol'; items: string[] }
  | { t: 'table'; rows: string[][]; header: boolean }
  | { t: 'quote'; html: string }
  | { t: 'hr' }
  | { t: 'refs'; items: string[] }
  | { t: 'image'; dataUri: string; caption?: string };

const REF_HEADING = /^(المراجع|المصادر|قائمة المراجع|references|bibliography)\s*:?\s*$/i;
const CHAPTER = /^(الفصل|الباب|المبحث|الوحدة|chapter)(?=$|\s)/i;
const SENTENCE_END = /[.。؟?!…،,]$/;
// Common section titles → treat a short line as a heading even without a blank
// line after it. (\b is avoided — it doesn't work with Arabic letters.)
const SECTION_KW =
  /^(ال)?(مقدمه|مقدمة|تمهيد|خاتمة|خاتمه|نتائج|توصيات|أهداف|اهداف|منهجية|منهجيه|ملخص|مصادر|مراجع|استنتاج|خلاصة|خلاصه|تعريف|مشكلة|مشكله|فرضية|فرضيه|دراسة|دراسه|محتوى|فهرس|abstract|introduction|conclusion|methodology|results|discussion)(?=$|[\s:：])/i;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Apply inline markdown (bold/italic/code) after HTML-escaping. */
export function inline(text: string): string {
  let s = escapeHtml(text);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}

const isBullet = (l: string) => /^[-*•▪●]\s+/.test(l);
const isOrdered = (l: string) => /^\d+[.)]\s+/.test(l);
const stripBullet = (l: string) => l.replace(/^[-*•▪●]\s+/, '');
const stripOrdered = (l: string) => l.replace(/^\d+[.)]\s+/, '');
const isTableRow = (l: string) => l.includes('|') && l.split('|').filter((c) => c.trim() !== '').length >= 2;
const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}.*$/.test(l) && l.includes('-') && !/[^\s|:.-]/.test(l);

function tableCells(l: string): string[] {
  return l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

/**
 * Parse raw content into ordered blocks. Detects markdown-style and
 * plain-text headings, lists, tables, quotes, a references section, and
 * paragraphs — cleaning stray whitespace as it goes.
 */
export function parseContent(raw: string): Block[] {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  let inRefs = false;

  const flushParagraph = (buf: string[]) => {
    const text = buf.join(' ').replace(/\s+/g, ' ').trim();
    if (text) blocks.push({ t: 'p', html: inline(text) });
  };

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) {
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^([-*_])\1{2,}$/.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }

    // Markdown headings.
    const md = /^(#{1,3})\s+(.*)$/.exec(line);
    if (md) {
      const level = md[1].length as 1 | 2 | 3;
      const text = md[2].replace(/[#\s]+$/, '').trim();
      inRefs = REF_HEADING.test(text);
      blocks.push({ t: (`h${level}` as 'h1' | 'h2' | 'h3'), text });
      i++;
      continue;
    }

    // Reference / chapter headings by keyword.
    if (REF_HEADING.test(line)) {
      inRefs = true;
      blocks.push({ t: 'h2', text: line.replace(/:$/, '') });
      i++;
      continue;
    }
    if (CHAPTER.test(line) && line.length < 60) {
      inRefs = false;
      blocks.push({ t: 'h1', text: line });
      i++;
      continue;
    }

    // Tables: a row (optionally followed by a --- separator) then more rows.
    if (isTableRow(line) && (i + 1 >= lines.length || !isBullet(lines[i + 1]?.trim() ?? ''))) {
      const rows: string[][] = [];
      let header = false;
      let j = i;
      while (j < lines.length && isTableRow(lines[j].trim())) {
        if (isTableSep(lines[j].trim())) {
          header = rows.length === 1;
          j++;
          continue;
        }
        rows.push(tableCells(lines[j].trim()).map((c) => inline(c)));
        j++;
      }
      if (rows.length >= 2 || (rows.length >= 1 && header)) {
        blocks.push({ t: 'table', rows, header });
        i = j;
        continue;
      }
    }

    // Blockquote.
    if (line.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        buf.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ t: 'quote', html: inline(buf.join(' ')) });
      continue;
    }

    // Lists (bulleted / ordered). In a references section, bullets become refs.
    if (isBullet(line) || isOrdered(line)) {
      const ordered = isOrdered(line);
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i].trim();
        if (isBullet(l)) items.push(inline(stripBullet(l)));
        else if (isOrdered(l)) items.push(inline(stripOrdered(l)));
        else break;
        i++;
      }
      if (inRefs) blocks.push({ t: 'refs', items });
      else blocks.push({ t: ordered ? 'ol' : 'ul', items });
      continue;
    }

    // Plain-text heading heuristic: a short line that is a known section title,
    // ends with a colon, or stands alone before a blank line (not a wrapped
    // paragraph start). Conservative to avoid mis-heading normal sentences.
    const next = lines[i + 1]?.trim() ?? '';
    const endsColon = /[:：]$/.test(line);
    const short = line.length <= 55 && line.split(/\s+/).length <= 8;
    if (!inRefs && short && (endsColon || SECTION_KW.test(line) || (next === '' && !SENTENCE_END.test(line)))) {
      blocks.push({ t: 'h2', text: line.replace(/[:：]\s*$/, '') });
      i++;
      continue;
    }

    // References as plain lines.
    if (inRefs) {
      const items: string[] = [];
      while (i < lines.length && lines[i].trim()) {
        items.push(inline(lines[i].trim()));
        i++;
      }
      blocks.push({ t: 'refs', items });
      continue;
    }

    // Paragraph: accumulate until a blank line.
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim()) {
      const l = lines[i].trim();
      if (isBullet(l) || isOrdered(l) || l.startsWith('>') || /^#{1,3}\s/.test(l)) break;
      buf.push(l);
      i++;
    }
    flushParagraph(buf);
  }

  return blocks;
}

/** Extract headings for a table of contents. */
export function tableOfContents(blocks: Block[]): { level: number; text: string; id: string }[] {
  const toc: { level: number; text: string; id: string }[] = [];
  let n = 0;
  for (const b of blocks) {
    if (b.t === 'h1' || b.t === 'h2') {
      toc.push({ level: b.t === 'h1' ? 1 : 2, text: b.text, id: `sec-${n++}` });
    }
  }
  return toc;
}
