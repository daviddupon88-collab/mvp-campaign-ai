import { ConfigService } from '@nestjs/config';
import { SocialApiError } from './social-api-error';
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

describe('TikTokAdapter.publish', () => {
  let fetchMock: jest.Mock;
  beforeEach(() => { fetchMock = jest.fn(); global.fetch = fetchMock as any; });

  it('initie la publication PULL_FROM_URL et renvoie le publish_id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { publish_id: 'pub-123' } }));
    const adapter = buildAdapter();

    const result = await adapter.publish({ accessToken: 't', externalAccountId: 'open-id-1', mediaUrl: 'https://cdn.example.com/video.mp4', caption: 'Bonjour' });
    expect(result).toEqual({ externalPostId: 'pub-123' });
  });

  it('refuse de publier sans mediaUrl (TikTok exige une vidéo)', async () => {
    const adapter = buildAdapter();
    await expect(adapter.publish({ accessToken: 't', externalAccountId: 'open-id-1' })).rejects.toThrow(SocialApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lève une SocialApiError si TikTok ne renvoie aucun publish_id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: {} }));
    const adapter = buildAdapter();

    await expect(adapter.publish({ accessToken: 't', externalAccountId: 'open-id-1', mediaUrl: 'https://cdn.example.com/video.mp4' })).rejects.toThrow(SocialApiError);
  });
});

describe('TikTokAdapter.checkPublishStatus', () => {
  let fetchMock: jest.Mock;
  beforeEach(() => { fetchMock = jest.fn(); global.fetch = fetchMock as any; });

  it.each([
    ['PUBLISH_COMPLETE', 'PUBLISHED'],
    ['FAILED', 'FAILED'],
    ['PROCESSING_UPLOAD', 'PROCESSING'],
  ])('mappe le statut TikTok "%s" vers "%s"', async (tiktokStatus, expected) => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { status: tiktokStatus } }));
    const adapter = buildAdapter();

    const status = await adapter.checkPublishStatus!('t', 'pub-123');
    expect(status).toBe(expected);
  });
});

describe('TikTokAdapter.exchangeCodeForToken', () => {
  let fetchMock: jest.Mock;
  beforeEach(() => { fetchMock = jest.fn(); global.fetch = fetchMock as any; });

  it('échange le code contre un token avec open_id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'token-1', refresh_token: 'refresh-1', expires_in: 86400, open_id: 'open-id-1', scope: 'video.publish' }));
    const adapter = buildAdapter();

    const result = await adapter.exchangeCodeForToken({ code: 'code-1', redirectUri: 'https://app.example.com/callback' });
    expect(result.accessToken).toBe('token-1');
    expect(result.externalAccountId).toBe('open-id-1');
  });
});
