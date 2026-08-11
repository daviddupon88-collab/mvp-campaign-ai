import { ConfigService } from '@nestjs/config';
import { MetaAdapter } from './meta.adapter';
import { SocialApiError } from './social-api-error';

function buildAdapter() {
  const config = {
    get: (key: string, fallback?: string) => (key === 'META_APP_ID' ? 'app-id' : key === 'META_APP_SECRET' ? 'app-secret' : fallback ?? ''),
  } as unknown as ConfigService;
  return new MetaAdapter(config);
}

function jsonResponse(body: any, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe('MetaAdapter', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('publish', () => {
    it('publie sur /feed (texte simple) quand aucun média n\'est fourni', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: 'post_123' }));
      const adapter = buildAdapter();

      const result = await adapter.publish({ accessToken: 'token', externalAccountId: 'page-1', caption: 'Bonjour' });

      expect(result).toEqual({ externalPostId: 'post_123' });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('/page-1/feed');
    });

    it('publie sur /photos quand un mediaUrl est fourni', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ post_id: 'post_456' }));
      const adapter = buildAdapter();

      const result = await adapter.publish({
        accessToken: 'token',
        externalAccountId: 'page-1',
        caption: 'Visuel',
        mediaUrl: 'https://cdn.example.com/img.png',
      });

      expect(result).toEqual({ externalPostId: 'post_456' });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('/page-1/photos');
    });

    it('lève une SocialApiError retryable sur une erreur serveur Meta (5xx)', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: 'oops' }, false, 503));
      const adapter = buildAdapter();

      await expect(adapter.publish({ accessToken: 't', externalAccountId: 'p' })).rejects.toMatchObject({
        name: 'SocialApiError',
        retryable: true,
      });
    });

    it('lève une SocialApiError non-retryable sur un token invalide (401)', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid token' }, false, 401));
      const adapter = buildAdapter();

      await expect(adapter.publish({ accessToken: 't', externalAccountId: 'p' })).rejects.toMatchObject({
        name: 'SocialApiError',
        retryable: false,
      });
    });
  });

  describe('exchangeCodeForToken', () => {
    it('enchaîne échange court terme → longue durée → récupération de la Page', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: 'short-lived' })) // étape 1
        .mockResolvedValueOnce(jsonResponse({ access_token: 'long-lived', expires_in: 5184000 })) // étape 2
        .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'page-1', name: 'Ma Page', access_token: 'page-token' }] })); // étape 3

      const adapter = buildAdapter();
      const result = await adapter.exchangeCodeForToken({ code: 'code-1', redirectUri: 'https://app.example.com/callback' });

      expect(result.accessToken).toBe('page-token'); // le token de PAGE, pas le token utilisateur
      expect(result.externalAccountId).toBe('page-1');
      expect(result.externalAccountName).toBe('Ma Page');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('lève une erreur non-retryable si le compte ne gère aucune Page', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: 'short-lived' }))
        .mockResolvedValueOnce(jsonResponse({ access_token: 'long-lived' }))
        .mockResolvedValueOnce(jsonResponse({ data: [] })); // aucune page

      const adapter = buildAdapter();
      await expect(
        adapter.exchangeCodeForToken({ code: 'code-1', redirectUri: 'https://app.example.com/callback' }),
      ).rejects.toThrow(SocialApiError);
    });
  });

  describe('fetchInsights', () => {
    it('renvoie un objet vide (échec silencieux) si l\'appel échoue — non-critique', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, false, 500));
      const adapter = buildAdapter();

      const result = await adapter.fetchInsights!({ accessToken: 't', externalPostId: 'post-1', externalAccountId: 'page-1' });
      expect(result).toEqual({});
    });

    it('extrait impressions et engagement depuis la réponse Graph API', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          data: [
            { name: 'post_impressions', values: [{ value: 1000 }] },
            { name: 'post_engaged_users', values: [{ value: 42 }] },
          ],
        }),
      );
      const adapter = buildAdapter();

      const result = await adapter.fetchInsights!({ accessToken: 't', externalPostId: 'post-1', externalAccountId: 'page-1' });
      expect(result.impressions).toBe(1000);
      expect(result.clicks).toBe(42);
    });
  });
});
