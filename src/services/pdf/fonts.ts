import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../../core/logger';

const log = createLogger('pdf:fonts');

const CAIRO = 'node_modules/@fontsource/cairo/files';
const AMIRI = 'node_modules/@fontsource/amiri/files';

// Split subsets so the browser shapes Arabic and Latin from the right glyphs.
const AR_RANGE = 'U+0600-06FF,U+0750-077F,U+0870-08FF,U+FB50-FDFF,U+FE70-FEFF';
const LAT_RANGE = 'U+0000-00FF,U+0100-024F,U+2000-206F,U+2070-209F,U+20A0-20CF,U+2100-214F';

interface FaceSpec {
  family: string;
  weight: number;
  dir: string;
  file: string;
  range: string;
}

const FACES: FaceSpec[] = [
  { family: 'Cairo', weight: 400, dir: CAIRO, file: 'cairo-arabic-400-normal.woff2', range: AR_RANGE },
  { family: 'Cairo', weight: 400, dir: CAIRO, file: 'cairo-latin-400-normal.woff2', range: LAT_RANGE },
  { family: 'Cairo', weight: 700, dir: CAIRO, file: 'cairo-arabic-700-normal.woff2', range: AR_RANGE },
  { family: 'Cairo', weight: 700, dir: CAIRO, file: 'cairo-latin-700-normal.woff2', range: LAT_RANGE },
  { family: 'Amiri', weight: 400, dir: AMIRI, file: 'amiri-arabic-400-normal.woff2', range: AR_RANGE },
  { family: 'Amiri', weight: 400, dir: AMIRI, file: 'amiri-latin-400-normal.woff2', range: LAT_RANGE },
  { family: 'Amiri', weight: 700, dir: AMIRI, file: 'amiri-arabic-700-normal.woff2', range: AR_RANGE },
  { family: 'Amiri', weight: 700, dir: AMIRI, file: 'amiri-latin-700-normal.woff2', range: LAT_RANGE },
];

let cached: string | null = null;

/** Build a block of @font-face rules with the fonts embedded as base64 data URIs. */
export function fontFaceCss(): string {
  if (cached) return cached;
  const rules: string[] = [];
  for (const f of FACES) {
    try {
      const b64 = readFileSync(join(f.dir, f.file)).toString('base64');
      rules.push(
        `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};` +
          `unicode-range:${f.range};` +
          `src:url(data:font/woff2;base64,${b64}) format('woff2');}`,
      );
    } catch (err) {
      log.warn({ err, file: f.file }, 'font file missing');
    }
  }
  cached = rules.join('\n');
  return cached;
}
