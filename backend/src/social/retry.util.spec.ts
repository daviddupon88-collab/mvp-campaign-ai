import { withRetry } from './retry.util';
import { SocialApiError } from './adapters/social-api-error';

describe('withRetry', () => {
  it('retourne le résultat immédiatement si le premier appel réussit (aucun retry)', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retente une erreur retryable jusqu\'à réussite, sans dépasser maxAttempts', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new SocialApiError('rate limited', { platform: 'META_FACEBOOK', retryable: true, statusCode: 429 }))
      .mockResolvedValueOnce('ok-apres-retry');

    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe('ok-apres-retry');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('ne retente JAMAIS une erreur non-retryable — échoue dès la première tentative', async () => {
    const authError = new SocialApiError('unauthorized', { platform: 'META_FACEBOOK', retryable: false, statusCode: 401 });
    const fn = jest.fn().mockRejectedValue(authError);

    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toBe(authError);
    // Le point critique : une seule tentative, jamais deux, pour une erreur d'authentification.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('abandonne après maxAttempts même si l\'erreur reste retryable', async () => {
    const rateLimitError = new SocialApiError('rate limited', { platform: 'GOOGLE_ADS', retryable: true, statusCode: 429 });
    const fn = jest.fn().mockRejectedValue(rateLimitError);

    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toBe(rateLimitError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('une erreur générique (non SocialApiError) est traitée comme non-retryable', async () => {
    const genericError = new Error('erreur inattendue');
    const fn = jest.fn().mockRejectedValue(genericError);

    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toBe(genericError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('SocialApiError.fromHttpStatus', () => {
  it('classe 429 et 5xx comme retryable', () => {
    expect(SocialApiError.fromHttpStatus('META_FACEBOOK', 429, 'rate limit').retryable).toBe(true);
    expect(SocialApiError.fromHttpStatus('META_FACEBOOK', 500, 'server error').retryable).toBe(true);
    expect(SocialApiError.fromHttpStatus('META_FACEBOOK', 503, 'unavailable').retryable).toBe(true);
  });

  it('classe 4xx (hors 429) comme non-retryable', () => {
    expect(SocialApiError.fromHttpStatus('META_FACEBOOK', 400, 'bad request').retryable).toBe(false);
    expect(SocialApiError.fromHttpStatus('META_FACEBOOK', 401, 'unauthorized').retryable).toBe(false);
    expect(SocialApiError.fromHttpStatus('META_FACEBOOK', 404, 'not found').retryable).toBe(false);
  });
});
