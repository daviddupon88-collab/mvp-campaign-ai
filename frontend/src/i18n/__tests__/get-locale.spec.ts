const mockCookiesGet = jest.fn();
const mockHeadersGet = jest.fn();

jest.mock('next/headers', () => ({
  cookies: jest.fn(async () => ({ get: mockCookiesGet })),
  headers: jest.fn(async () => ({ get: mockHeadersGet })),
}));

import { getUserLocale } from '../get-locale';

describe('getUserLocale', () => {
  beforeEach(() => {
    mockCookiesGet.mockReset();
    mockHeadersGet.mockReset();
  });

  it('uses the NEXT_LOCALE cookie when present and supported (persisted local/account preference)', async () => {
    mockCookiesGet.mockReturnValue({ value: 'de' });
    mockHeadersGet.mockReturnValue('fr-FR,fr;q=0.9');

    // Le cookie l'emporte sur l'en-tête Accept-Language même quand ils divergent —
    // c'est exactement le cas "compte/local différent du navigateur" de la mission.
    expect(await getUserLocale()).toBe('de');
  });

  it('falls back to Accept-Language when no cookie is set', async () => {
    mockCookiesGet.mockReturnValue(undefined);
    mockHeadersGet.mockReturnValue('ar-SA,ar;q=0.9');

    expect(await getUserLocale()).toBe('ar');
  });

  it('ignores an invalid/unsupported cookie value and falls back to Accept-Language', async () => {
    mockCookiesGet.mockReturnValue({ value: 'xx' });
    mockHeadersGet.mockReturnValue('de-DE');

    expect(await getUserLocale()).toBe('de');
  });

  it('defaults to English when neither cookie nor Accept-Language resolve to a supported locale', async () => {
    mockCookiesGet.mockReturnValue(undefined);
    mockHeadersGet.mockReturnValue(null);

    expect(await getUserLocale()).toBe('en');
  });
});
