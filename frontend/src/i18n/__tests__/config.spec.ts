import { DEFAULT_LOCALE, SUPPORTED_LOCALES, isRtl, isSupportedLocale, matchBrowserLocale } from '../config';

describe('i18n config', () => {
  it('supports exactly en, de, fr, ar with en as default', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'de', 'fr', 'ar']);
    expect(DEFAULT_LOCALE).toBe('en');
  });

  it('flags only ar as RTL', () => {
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('en')).toBe(false);
    expect(isRtl('de')).toBe(false);
    expect(isRtl('fr')).toBe(false);
  });

  it('validates supported locales only', () => {
    expect(isSupportedLocale('en')).toBe(true);
    expect(isSupportedLocale('ar')).toBe(true);
    expect(isSupportedLocale('es')).toBe(false);
    expect(isSupportedLocale(undefined)).toBe(false);
    expect(isSupportedLocale(null)).toBe(false);
  });

  describe('matchBrowserLocale', () => {
    it.each([
      ['en-US,en;q=0.9', 'en'],
      ['de-DE,de;q=0.9,en;q=0.8', 'de'],
      ['fr-FR,fr;q=0.9', 'fr'],
      ['ar-SA,ar;q=0.9', 'ar'],
      ['ar', 'ar'],
    ])('maps Accept-Language "%s" to %s', (header, expected) => {
      expect(matchBrowserLocale(header)).toBe(expected);
    });

    it('falls back to English for any unsupported browser language', () => {
      expect(matchBrowserLocale('es-ES,es;q=0.9')).toBe('en');
      expect(matchBrowserLocale('ja-JP')).toBe('en');
      expect(matchBrowserLocale('zh-CN,zh;q=0.9')).toBe('en');
    });

    it('falls back to English when the header is missing or empty', () => {
      expect(matchBrowserLocale(null)).toBe('en');
      expect(matchBrowserLocale(undefined)).toBe('en');
      expect(matchBrowserLocale('')).toBe('en');
    });

    it('picks the first supported language when multiple are offered', () => {
      expect(matchBrowserLocale('es-ES,fr;q=0.8,de;q=0.7')).toBe('fr');
    });
  });
});
