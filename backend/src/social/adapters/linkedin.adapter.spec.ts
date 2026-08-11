import { ConfigService } from '@nestjs/config';
import { SocialApiError } from './social-api-error';
import { LinkedInAdapter } from './linkedin.adapter';

function buildAdapter() {
  const config = { get: (_key: string, fallback?: string) => fallback ?? '' } as unknown as ConfigService;
  return new LinkedInAdapter(config);
}

function jsonResponse(body: any, ok = true, status = 200, headerValue: string | null = null) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => headerValue } } as unknown as Response;
}

describe('LinkedInAdapter.fetchInsights', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
  });

  it("interroge organizationalEntityShareStatistics avec l'URN d'organisation ET celui du partage", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ elements: [{ totalShareStatistics: { impressionCount: 5000, clickCount: 120 } }] }),
    );
    const adapter = buildAdapter();

    const result = await adapter.fetchInsights({
      accessToken: 't',
      externalPostId: 'urn:li:ugcPost:123',
      externalAccountId: 'urn:li:organization:456',
    });

    expect(result).toEqual({ impressions: 5000, clicks: 120, raw: expect.anything() });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('organizationalEntity=urn%3Ali%3Aorganization%3A456');
    expect(url).toContain('shares%5B0%5D=urn%3Ali%3AugcPost%3A123');
  });

  it('renvoie un objet vide (échec silencieux) si LinkedIn répond en erreur', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 403));
    const adapter = buildAdapter();

    const result = await adapter.fetchInsights({ accessToken: 't', externalPostId: 'urn:li:ugcPost:123', externalAccountId: 'urn:li:organization:456' });
    expect(result).toEqual({});
  });

  it('renvoie un objet vide si la réponse ne contient aucune statistique (pas de crash)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ elements: [] }));
    const adapter = buildAdapter();

    const result = await adapter.fetchInsights({ accessToken: 't', externalPostId: 'urn:li:ugcPost:123', externalAccountId: 'urn:li:organization:456' });
    expect(result).toEqual({});
  });
});

describe('LinkedInAdapter.publish', () => {
  let fetchMock: jest.Mock;
  beforeEach(() => { fetchMock = jest.fn(); global.fetch = fetchMock as any; });

  it("publie via ugcPosts et récupère l'ID depuis l'en-tête x-restli-id", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, true, 201, 'urn:li:ugcPost:789'));
    const adapter = buildAdapter();

    const result = await adapter.publish({ accessToken: 't', externalAccountId: 'urn:li:organization:456', caption: 'Bonjour' });
    expect(result).toEqual({ externalPostId: 'urn:li:ugcPost:789' });
  });

  it('lève une SocialApiError sur un échec de publication', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'forbidden' }, false, 403));
    const adapter = buildAdapter();

    await expect(adapter.publish({ accessToken: 't', externalAccountId: 'urn:li:organization:456' })).rejects.toThrow(SocialApiError);
  });
});

describe('LinkedInAdapter.exchangeCodeForToken', () => {
  let fetchMock: jest.Mock;
  beforeEach(() => { fetchMock = jest.fn(); global.fetch = fetchMock as any; });

  it("enchaîne l'échange de token puis la récupération de l'organisation administrée", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-1', refresh_token: 'refresh-1', expires_in: 5184000 }))
      .mockResolvedValueOnce(jsonResponse({ elements: [{ organizationalTarget: 'urn:li:organization:456' }] }));

    const adapter = buildAdapter();
    const result = await adapter.exchangeCodeForToken({ code: 'code-1', redirectUri: 'https://app.example.com/callback' });

    expect(result.accessToken).toBe('token-1');
    expect(result.externalAccountId).toBe('urn:li:organization:456');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retombe sur un identifiant personnel si aucune organisation n'est administrée", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-1', expires_in: 5184000 }))
      .mockResolvedValueOnce(jsonResponse({ elements: [] }));

    const adapter = buildAdapter();
    const result = await adapter.exchangeCodeForToken({ code: 'code-1', redirectUri: 'https://app.example.com/callback' });
    expect(result.externalAccountId).toBe('urn:li:person:me');
  });
});
