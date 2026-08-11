import { ConfigService } from '@nestjs/config';
import { TikTokAdapter } from './tiktok.adapter';

function buildAdapter() {
  const config = { get: (_key: string, fallback?: string) => fallback ?? '' } as unknown as ConfigService;
  return new TikTokAdapter(config);
}

function jsonResponse(body: any, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe('TikTokAdapter.fetchInsights', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
  });

  it("interroge Query Video List et convertit l'engagement (like+comment+share) en proxy de clicks", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { videos: [{ id: 'v1', view_count: 15000, like_count: 800, comment_count: 40, share_count: 60 }] } }),
    );
    const adapter = buildAdapter();

    const result = await adapter.fetchInsights({ accessToken: 't', externalPostId: 'v1', externalAccountId: 'open-id-1' });

    expect(result).toEqual({ impressions: 15000, clicks: 900, raw: expect.anything() });
  });

  it('renvoie un objet vide (échec silencieux) si TikTok répond en erreur', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 500));
    const adapter = buildAdapter();

    const result = await adapter.fetchInsights({ accessToken: 't', externalPostId: 'v1', externalAccountId: 'open-id-1' });
    expect(result).toEqual({});
  });

  it('renvoie un objet vide si la vidéo est introuvable dans la réponse', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { videos: [] } }));
    const adapter = buildAdapter();

    const result = await adapter.fetchInsights({ accessToken: 't', externalPostId: 'v1', externalAccountId: 'open-id-1' });
    expect(result).toEqual({});
  });
});
