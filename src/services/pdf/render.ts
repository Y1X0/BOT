import { getBrowser } from './browser';
import { buildHtml, footerTemplate, type DocMeta } from './document';
import { parseContent, type Block } from './parse';
import { themeForKey, labelForKey } from './themes';
import { createLogger } from '../../core/logger';

const log = createLogger('pdf:render');

export interface PdfRequest {
  title: string;
  typeKey: string; // theme key
  customType?: string; // used when typeKey === 'plain' but user named a type
  cover: { label: string; value: string }[];
  content: string;
  images: { dataUri: string; caption?: string }[];
  date?: string;
}

/** Render an HTML document to a PDF buffer. */
export async function htmlToPdf(html: string, opts: { pageNumbers: boolean; accent: string }): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle', timeout: 45_000 });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', bottom: '16mm', left: '16mm', right: '16mm' },
      displayHeaderFooter: opts.pageNumbers,
      headerTemplate: '<div></div>',
      footerTemplate: opts.pageNumbers ? footerTemplate(opts.accent) : '<div></div>',
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Build blocks (text + trailing images) and render the finished PDF. */
export async function createPdf(req: PdfRequest): Promise<Buffer> {
  const theme = themeForKey(req.typeKey);
  const blocks: Block[] = parseContent(req.content || '');
  for (const img of req.images) blocks.push({ t: 'image', dataUri: img.dataUri, caption: img.caption });

  const meta: DocMeta = {
    title: req.title || 'مستند',
    typeLabel: req.customType || labelForKey(req.typeKey) || 'مستند',
    cover: req.cover,
    date: req.date,
  };
  const html = buildHtml(meta, blocks, theme);
  log.info({ blocks: blocks.length, theme: theme.id }, 'rendering pdf');
  return htmlToPdf(html, { pageNumbers: theme.pageNumbers, accent: theme.accent });
}
