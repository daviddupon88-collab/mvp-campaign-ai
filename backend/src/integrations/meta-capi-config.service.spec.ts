import { MetaCapiConfigService } from './meta-capi-config.service';

function buildService() {
  const findUnique = jest.fn();
  const upsert = jest.fn().mockResolvedValue({});
  const prisma = { metaCapiConfig: { findUnique, upsert } } as any;

  const encrypt = jest.fn().mockReturnValue('iv:tag:encrypted-token');
  const tokenCrypto = { encrypt } as any;

  const service = new MetaCapiConfigService(prisma, tokenCrypto);
  return { service, findUnique, upsert, encrypt };
}

describe('MetaCapiConfigService', () => {
  describe('getStatus', () => {
    it('renvoie configured=false quand aucune config n\'existe, sans jamais exposer de token', async () => {
      const { service, findUnique } = buildService();
      findUnique.mockResolvedValue(null);

      const result = await service.getStatus('org-1');

      expect(result).toEqual({ configured: false, pixelId: null, enabled: false });
    });

    it('renvoie le statut sans jamais inclure accessToken, même chiffré', async () => {
      const { service, findUnique } = buildService();
      findUnique.mockResolvedValue({ pixelId: 'pixel-1', accessToken: 'iv:tag:secret', enabled: true });

      const result = await service.getStatus('org-1');

      expect(result).toEqual({ configured: true, pixelId: 'pixel-1', enabled: true });
      expect(result).not.toHaveProperty('accessToken');
    });
  });

  describe('update', () => {
    it('chiffre le token avant de l\'écrire, jamais en clair', async () => {
      const { service, upsert, encrypt, findUnique } = buildService();
      findUnique.mockResolvedValue({ pixelId: 'pixel-1', accessToken: 'iv:tag:encrypted-token', enabled: true });

      await service.update('org-1', { pixelId: 'pixel-1', accessToken: 'plain-secret-token', enabled: true });

      expect(encrypt).toHaveBeenCalledWith('plain-secret-token');
      const call = upsert.mock.calls[0][0];
      expect(call.create.accessToken).toBe('iv:tag:encrypted-token');
      expect(call.update.accessToken).toBe('iv:tag:encrypted-token');
      expect(call.create.accessToken).not.toBe('plain-secret-token');
    });
  });
});
