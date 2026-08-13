const mockCookiesSet = jest.fn();

jest.mock('next/headers', () => ({
  cookies: jest.fn(async () => ({ set: mockCookiesSet })),
}));

import { setLocaleCookie } from '../set-locale';

describe('setLocaleCookie', () => {
  beforeEach(() => {
    mockCookiesSet.mockReset();
  });

  it.each(['en', 'de', 'fr', 'ar'])('persists a supported locale (%s) to the NEXT_LOCALE cookie', async (locale) => {
    await setLocaleCookie(locale);
    expect(mockCookiesSet).toHaveBeenCalledWith('NEXT_LOCALE', locale, expect.objectContaining({ path: '/' }));
  });

  it('never persists an unsupported/arbitrary value (rejects locale injection)', async () => {
    await setLocaleCookie('es');
    await setLocaleCookie('<script>alert(1)</script>');
    await setLocaleCookie('');
    expect(mockCookiesSet).not.toHaveBeenCalled();
  });
});
