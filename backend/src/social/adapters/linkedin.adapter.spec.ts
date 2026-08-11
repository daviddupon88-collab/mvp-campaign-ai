import { ConfigService } from '@nestjs/config';
import { LinkedInAdapter } from './linkedin.adapter';

function buildAdapter() {
  const config = { get: (_key: string, fallback?: string) => fallback ?? '' } as unknown as ConfigService;
  return new LinkedInAdapter(config);
}

function jsonResponse(body: any, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } } as unknown as Response;
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
