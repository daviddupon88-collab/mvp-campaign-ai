import { AuditService } from './audit.service';
import { PrismaService } from '../prisma/prisma.service';

function buildPrismaMock(createImpl: jest.Mock) {
  return { auditLog: { create: createImpl, findMany: jest.fn() } } as unknown as PrismaService;
}

describe('AuditService', () => {
  it('écrit une ligne d\'audit avec tous les champs fournis', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'log-1' });
    const prisma = buildPrismaMock(create);
    const service = new AuditService(prisma);

    await service.record(
      'campaign.approved',
      'Campaign',
      'campaign-1',
      { organizationId: 'org-1', actorUserId: 'user-1', actorEmail: 'a@b.com', ipAddress: '1.2.3.4', userAgent: 'test-agent' },
      { note: 'détail' },
    );

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'campaign.approved',
        resourceType: 'Campaign',
        resourceId: 'campaign-1',
        organizationId: 'org-1',
        actorUserId: 'user-1',
        actorEmail: 'a@b.com',
        ipAddress: '1.2.3.4',
        userAgent: 'test-agent',
        metadata: { note: 'détail' },
      }),
    });
  });

  it('ne relance JAMAIS d\'exception si l\'écriture échoue — best-effort par design', async () => {
    const create = jest.fn().mockRejectedValue(new Error('base indisponible'));
    const prisma = buildPrismaMock(create);
    const service = new AuditService(prisma);

    // Le point critique de ce test : record() ne doit jamais propager l'erreur, pour ne
    // jamais faire échouer l'action métier qui l'a appelé (cf. commentaire de classe).
    await expect(
      service.record('campaign.approved', 'Campaign', 'campaign-1', { organizationId: 'org-1' }),
    ).resolves.toBeUndefined();
  });

  it('fonctionne sans organizationId ni actorUserId (action système, ex: cron)', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'log-2' });
    const prisma = buildPrismaMock(create);
    const service = new AuditService(prisma);

    await service.record('trial.expired', 'Subscription', 'sub-1', {});
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'trial.expired', organizationId: undefined, actorUserId: undefined }),
    });
  });
});
