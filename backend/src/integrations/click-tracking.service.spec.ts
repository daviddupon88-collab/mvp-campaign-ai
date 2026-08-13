import { ClickTrackingService } from './click-tracking.service';

describe('ClickTrackingService', () => {
  describe('recordClick', () => {
    it('crée bien une ligne TrackedClick avec les identifiants fournis', async () => {
      const create = jest.fn().mockResolvedValue({ id: 'click-1' });
      const service = new ClickTrackingService({ trackedClick: { create } } as any);

      await service.recordClick({ publishedPostId: 'post-1', campaignId: 'campaign-1', organizationId: 'org-1', fbclid: 'fbclid-x', gclid: undefined });

      expect(create).toHaveBeenCalledWith({
        data: { publishedPostId: 'post-1', campaignId: 'campaign-1', organizationId: 'org-1', fbclid: 'fbclid-x', gclid: undefined },
      });
    });

    // Best-effort, comme AuditService : un vrai clic publicitaire ne doit jamais échouer sa
    // redirection à cause d'un incident d'écriture — recordClick doit toujours résoudre.
    it('ne rejette jamais, même si Prisma échoue', async () => {
      const create = jest.fn().mockRejectedValue(new Error('DB indisponible'));
      const service = new ClickTrackingService({ trackedClick: { create } } as any);

      await expect(
        service.recordClick({ publishedPostId: 'post-1', campaignId: 'campaign-1', organizationId: 'org-1' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('findMostRecentClickWithFbclid', () => {
    it('filtre sur la campagne, un fbclid non nul, et trie par date décroissante', async () => {
      const findFirst = jest.fn().mockResolvedValue({ id: 'click-1', fbclid: 'fbclid-x' });
      const service = new ClickTrackingService({ trackedClick: { findFirst } } as any);

      const result = await service.findMostRecentClickWithFbclid('campaign-1');

      expect(result).toEqual({ id: 'click-1', fbclid: 'fbclid-x' });
      const args = findFirst.mock.calls[0][0];
      expect(args.where.campaignId).toBe('campaign-1');
      expect(args.where.fbclid).toEqual({ not: null });
      expect(args.orderBy).toEqual({ createdAt: 'desc' });
    });
  });
});
