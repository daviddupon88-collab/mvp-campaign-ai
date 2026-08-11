import { ConfigService } from '@nestjs/config';
import { GoogleAdsAdapter } from './google-ads.adapter';

function buildAdapter(hasDeveloperToken = true) {
  const config = {
    get: (key: string, fallback?: string) => (key === 'GOOGLE_ADS_DEVELOPER_TOKEN' ? (hasDeveloperToken ? 'dev-token' : '') : fallback ?? ''),
  } as unknown as ConfigService;
  return new GoogleAdsAdapter(config);
}

function jsonResponse(body: any, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe('GoogleAdsAdapter.fetchInsights', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
  });

  it('interroge googleAds:search scopé au customer (externalAccountId) et convertit costMicros en unité monétaire', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [{ metrics: { impressions: '10000', clicks: '250', costMicros: '5000000', conversions: 3, conversionsValue: 90.5 } }],
      }),
    );
    const adapter = buildAdapter();

    const result = await adapter.fetchInsights({
      accessToken: 't',
      externalPostId: 'customers/123/adGroupAds/456~789',
      externalAccountId: '123',
    });

    expect(result).toEqual({ impressions: 10000, clicks: 250, spend: 5, conversions: 3, conversionValue: 90.5, raw: expect.anything() });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/customers/123/googleAds:search');
  });

  it("n'appelle jamais l'API sans developer token configuré (échec silencieux)", async () => {
    const adapter = buildAdapter(false);
    const result = await adapter.fetchInsights({ accessToken: 't', externalPostId: 'x', externalAccountId: '123' });
    expect(result).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renvoie un objet vide si aucun résultat ne correspond (annonce introuvable)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [] }));
    const adapter = buildAdapter();

    const result = await adapter.fetchInsights({ accessToken: 't', externalPostId: 'x', externalAccountId: '123' });
    expect(result).toEqual({});
  });
});
