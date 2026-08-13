import { MetaCapiService } from './meta-capi.service';

function jsonResponse(body: any, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

const CLICK_CREATED_AT = new Date('2026-08-13T10:00:00Z');

function buildService(opts: { config?: any; click?: any } = {}) {
  const findUnique = jest.fn().mockResolvedValue(opts.config === undefined ? { pixelId: 'pixel-1', accessToken: 'iv:tag:cipher', enabled: true } : opts.config);
  const prisma = { metaCapiConfig: { findUnique } } as any;

  const decrypt = jest.fn().mockReturnValue('decrypted-token');
  const tokenCrypto = { decrypt } as any;

  const findMostRecentClickWithFbclid = jest
    .fn()
    .mockResolvedValue(opts.click === undefined ? { fbclid: 'fbclid-abc', createdAt: CLICK_CREATED_AT } : opts.click);
  const clickTracking = { findMostRecentClickWithFbclid } as any;

  const service = new MetaCapiService(prisma, tokenCrypto, clickTracking);
  return { service, findUnique, findMostRecentClickWithFbclid, decrypt };
}

describe('MetaCapiService.pushConversion', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('ne fait aucun appel réseau quand aucune config Meta CAPI n\'existe pour l\'organisation', async () => {
    const { service } = buildService({ config: null });

    await service.pushConversion('org-1', 'campaign-1', { value: 100, currency: 'EUR' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ne fait aucun appel réseau quand la config existe mais est désactivée', async () => {
    const { service } = buildService({ config: { pixelId: 'pixel-1', accessToken: 'iv:tag:cipher', enabled: false } });

    await service.pushConversion('org-1', 'campaign-1', { value: 100, currency: 'EUR' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ne fait aucun appel réseau quand aucun clic récent avec fbclid n\'existe (pas d\'attribution possible)', async () => {
    const { service } = buildService({ click: null });

    await service.pushConversion('org-1', 'campaign-1', { value: 100, currency: 'EUR' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pousse un événement Purchase vers le pixel configuré avec un fbc dérivé du clic le plus récent', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ events_received: 1 }));
    const { service, decrypt } = buildService();

    await service.pushConversion('org-1', 'campaign-1', { value: 149.99, currency: 'EUR' });

    expect(decrypt).toHaveBeenCalledWith('iv:tag:cipher');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('graph.facebook.com');
    expect(url).toContain('/pixel-1/events');
    expect(url).toContain('access_token=decrypted-token');

    const body = JSON.parse(init.body);
    expect(body.data[0]).toMatchObject({
      event_name: 'Purchase',
      action_source: 'website',
      user_data: { fbc: `fb.1.${CLICK_CREATED_AT.getTime()}.fbclid-abc` },
      custom_data: { value: 149.99, currency: 'EUR' },
    });
  });

  it('n\'échoue jamais quand Meta répond en erreur — best-effort, journalisé et ignoré', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'Invalid token' } }, false, 401));
    const { service } = buildService();

    await expect(service.pushConversion('org-1', 'campaign-1', { value: 100, currency: 'EUR' })).resolves.toBeUndefined();
  });

  it('n\'échoue jamais quand fetch lève une exception (panne réseau)', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const { service } = buildService();

    await expect(service.pushConversion('org-1', 'campaign-1', { value: 100, currency: 'EUR' })).resolves.toBeUndefined();
  });
});
