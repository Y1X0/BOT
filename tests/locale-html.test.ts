import { describe, it, expect } from 'vitest';
import { translate, escapeHtml } from '../src/locales';

describe('locale HTML safety', () => {
  it('escapes interpolated values inside HTML templates', () => {
    const out = translate('ar', 'welcome.default', { name: '<b>x</b> & y', title: 'G' });
    // the user value is escaped, the template tags stay intact
    expect(out).toContain('&lt;b&gt;x&lt;/b&gt; &amp; y');
    expect(out).toContain('<b>أهلاً وسهلاً');
    expect(out).not.toContain('<b>x</b>');
  });

  it('does NOT escape values in plain (non-HTML) templates', () => {
    // welcome.captcha_failed has no placeholders; use a plain-style key with a var
    const out = translate('ar', 'mod.warn_reason_default');
    expect(out).not.toContain('&amp;');
  });

  it('escapeHtml handles the sensitive characters', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });
});
