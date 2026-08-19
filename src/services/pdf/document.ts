import { fontFaceCss } from './fonts';
import { escapeHtml, tableOfContents, type Block } from './parse';
import type { Theme } from './themes';

export interface DocMeta {
  title: string;
  typeLabel: string;
  cover: { label: string; value: string }[]; // optional cover fields
  date?: string;
}

const baseCss = (theme: Theme) => `
  :root{--accent:${theme.accent};--accent2:${theme.accent2};--tint:${theme.accent}12;--tint2:${theme.accent2}1f;--font:'${theme.font}';}
  *{box-sizing:border-box;}
  html,body{margin:0;padding:0;}
  body{font-family:var(--font),'Cairo','Amiri',sans-serif;font-size:${theme.bodySize};line-height:1.9;color:#20242e;direction:rtl;text-align:justify;}
  .page-break{page-break-after:always;}
  h1,h2,h3{font-weight:700;line-height:1.4;text-align:right;page-break-after:avoid;}
  /* Section headings — colored, spaced, easy to scan. */
  h1{font-size:1.7em;color:var(--accent);margin:1em 0 .55em;padding-bottom:.28em;border-bottom:3px solid var(--accent);}
  h1::before{content:"";display:inline-block;width:.55em;height:.55em;background:var(--accent2);border-radius:3px;margin-inline-end:.45em;vertical-align:middle;}
  h2{font-size:1.3em;color:var(--accent);margin:1.1em 0 .5em;padding:.4em .8em;background:var(--tint);border-inline-start:6px solid var(--accent2);border-radius:8px;}
  h3{font-size:1.12em;color:var(--accent2);margin:.85em 0 .35em;}
  h3::before{content:"▸";color:var(--accent2);margin-inline-end:.35em;font-weight:700;}
  p{margin:0 0 .75em;}
  strong,b{color:var(--accent);}
  ul,ol{margin:.35em 1.2em .9em 0;padding:0 1.1em 0 0;}
  li{margin:.3em 0;padding-inline-start:.15em;}
  ul li::marker{color:var(--accent2);}
  ol li::marker{color:var(--accent2);font-weight:700;}
  code{font-family:'Cairo',monospace;background:var(--tint);color:var(--accent);border-radius:4px;padding:1px 5px;font-size:.9em;}
  blockquote{margin:.9em 0;padding:.7em 1.1em;background:var(--tint);border-inline-start:5px solid var(--accent2);border-radius:8px;color:#333;}
  table{width:100%;border-collapse:collapse;margin:1em 0;font-size:.95em;box-shadow:0 1px 3px rgba(0,0,0,.06);border-radius:8px;overflow:hidden;}
  th,td{border:1px solid #dfe3ee;padding:8px 11px;text-align:right;}
  th{background:var(--accent);color:#fff;font-weight:700;}
  tr:nth-child(even) td{background:var(--tint);}
  figure{margin:1.1em 0;text-align:center;page-break-inside:avoid;}
  figure img{max-width:100%;max-height:120mm;border-radius:8px;border:1px solid #e3e3ea;box-shadow:0 2px 8px rgba(0,0,0,.08);}
  figcaption{font-size:.85em;color:#666;margin-top:6px;}
  hr{border:none;height:2px;background:linear-gradient(90deg,var(--accent2),transparent);margin:1.2em 0;}
  .refs{padding:0;margin:0.4em 0;}
  .refs li{direction:rtl;margin:0.4em 0;font-size:0.95em;}
  a{color:var(--accent2);}
  /* Cover */
  .cover{position:relative;height:247mm;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;page-break-after:always;}
  .cover::before{content:"";position:absolute;top:0;inset-inline:0;height:12mm;background:var(--accent);}
  .cover::after{content:"";position:absolute;bottom:0;inset-inline:0;height:6mm;background:var(--accent2);}
  .cover .badge{display:inline-block;color:#fff;background:var(--accent2);border-radius:20px;padding:5px 18px;font-size:.95em;letter-spacing:1px;margin-bottom:20px;}
  .cover h1.ct{font-size:2.6em;color:var(--accent);margin:0 0 6px;border:none;line-height:1.35;padding:0 6mm;}
  .cover h1.ct::before{content:none;}
  .cover .rule{width:130px;height:4px;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:3px;margin:20px auto 26px;}
  .cover .fields{margin-top:22px;font-size:1.05em;line-height:2.2;background:var(--tint);border-radius:12px;padding:16px 26px;}
  .cover .fields b{color:var(--accent);}
  .cover .date{margin-top:34px;color:#666;}
  /* TOC */
  .toc{page-break-after:always;}
  .toc h2{border-bottom:2px solid var(--accent2);padding-bottom:6px;}
  .toc .row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dotted #ccc;}
  .toc .row.l2{padding-inline-start:18px;font-size:0.95em;color:#444;}
  .toc .num{color:var(--accent2);font-weight:700;}
  ${theme.extraCss}
`;

function coverHtml(meta: DocMeta): string {
  const fields = meta.cover
    .filter((f) => f.value.trim())
    .map((f) => `<div><b>${escapeHtml(f.label)}:</b> ${escapeHtml(f.value)}</div>`)
    .join('');
  return (
    `<section class="cover">` +
    `<div class="badge">${escapeHtml(meta.typeLabel)}</div>` +
    `<h1 class="ct">${escapeHtml(meta.title)}</h1>` +
    `<div class="rule"></div>` +
    (fields ? `<div class="fields">${fields}</div>` : '') +
    (meta.date ? `<div class="date">${escapeHtml(meta.date)}</div>` : '') +
    `</section>`
  );
}

function tocHtml(blocks: Block[]): string {
  const toc = tableOfContents(blocks);
  if (toc.length < 2) return '';
  const rows = toc
    .map((t, i) => `<div class="row ${t.level === 2 ? 'l2' : ''}"><span>${escapeHtml(t.text)}</span><span class="num">${i + 1}</span></div>`)
    .join('');
  return `<section class="toc"><h2>الفهرس</h2>${rows}</section>`;
}

function blockHtml(b: Block, idFor: (b: Block) => string): string {
  switch (b.t) {
    case 'h1':
      return `<h1 id="${idFor(b)}">${escapeHtml(b.text)}</h1>`;
    case 'h2':
      return `<h2 id="${idFor(b)}">${escapeHtml(b.text)}</h2>`;
    case 'h3':
      return `<h3>${escapeHtml(b.text)}</h3>`;
    case 'p':
      return `<p>${b.html}</p>`;
    case 'ul':
      return `<ul>${b.items.map((x) => `<li>${x}</li>`).join('')}</ul>`;
    case 'ol':
      return `<ol>${b.items.map((x) => `<li>${x}</li>`).join('')}</ol>`;
    case 'refs':
      return `<ol class="refs">${b.items.map((x) => `<li>${x}</li>`).join('')}</ol>`;
    case 'quote':
      return `<blockquote>${b.html}</blockquote>`;
    case 'hr':
      return '<hr>';
    case 'table': {
      const rows = b.rows
        .map((r, ri) => {
          const cell = b.header && ri === 0 ? 'th' : 'td';
          return `<tr>${r.map((c) => `<${cell}>${c}</${cell}>`).join('')}</tr>`;
        })
        .join('');
      return `<table>${rows}</table>`;
    }
    case 'image':
      return `<figure><img src="${b.dataUri}">${b.caption ? `<figcaption>${escapeHtml(b.caption)}</figcaption>` : ''}</figure>`;
  }
}

/** Assemble the full self-contained HTML document. */
export function buildHtml(meta: DocMeta, blocks: Block[], theme: Theme): string {
  const ids = new Map<Block, string>();
  let n = 0;
  const idFor = (b: Block) => {
    if (!ids.has(b)) ids.set(b, `sec-${n++}`);
    return ids.get(b)!;
  };
  const body =
    (theme.cover ? coverHtml(meta) : `<h1 class="doc-title">${escapeHtml(meta.title)}</h1>`) +
    (theme.toc ? tocHtml(blocks) : '') +
    `<main>${blocks.map((b) => blockHtml(b, idFor)).join('\n')}</main>`;
  return (
    `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">` +
    `<title>${escapeHtml(meta.title)}</title><style>${fontFaceCss()}\n${baseCss(theme)}</style></head>` +
    `<body>${body}</body></html>`
  );
}

/** Footer template (page numbers) for Playwright — Western digits, no Arabic. */
export function footerTemplate(accent: string): string {
  return `<div style="width:100%;text-align:center;font-size:9px;color:${accent};font-family:sans-serif;padding-top:2px;"><span class="pageNumber"></span></div>`;
}
