import { BrandMemoryQueryService } from './brand-memory-query.service';
import { PrismaService } from '../prisma/prisma.service';

function buildService(entries: any[]) {
  const findMany = jest.fn().mockResolvedValue(entries);
  const prisma = { brandMemoryEntry: { findMany } } as unknown as PrismaService;
  const service = new BrandMemoryQueryService(prisma);
  return { service, findMany };
}

const now = new Date();

function entry(overrides: Partial<any>): any {
  return {
    id: 'e', content: 'x', confidenceScore: 0.5, lastObservedAt: now, scope: 'GLOBAL',
    channel: null, persona: null, contentType: null, category: null, status: 'ACTIVE',
    ...overrides,
  };
}

describe('BrandMemoryQueryService.findRelevant', () => {
  it('ne récupère que les entrées ACTIVE, jamais CONTRADICTED/DISMISSED (Phase 9/11)', async () => {
    const { service, findMany } = buildService([]);
    await service.findRelevant({ organizationId: 'org-1' });
    expect(findMany.mock.calls[0][0].where.status).toBe('ACTIVE');
  });

  it('inclut GLOBAL et le scope demandé dans la clause OR côté requête', async () => {
    const { service, findMany } = buildService([]);
    await service.findRelevant({ organizationId: 'org-1', channel: 'linkedin' });
    const or = findMany.mock.calls[0][0].where.OR;
    expect(or).toEqual(expect.arrayContaining([{ scope: 'GLOBAL' }, { scope: 'CHANNEL', channel: 'linkedin' }, { channel: 'linkedin' }]));
  });

  it('trie par confiance effective décroissante (décroissance temporelle appliquée)', async () => {
    const recentHighConfidence = entry({ id: 'recent', confidenceScore: 0.6, lastObservedAt: now });
    const oldHigherRawConfidence = entry({ id: 'old', confidenceScore: 0.9, lastObservedAt: new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000) });
    const { service } = buildService([oldHigherRawConfidence, recentHighConfidence]);

    const result = await service.findRelevant({ organizationId: 'org-1' });

    // Une confiance brute plus élevée mais très ancienne doit pouvoir être dépassée par une
    // confiance plus modeste mais fraîche — sinon la décroissance temporelle n'aurait aucun effet.
    expect(result[0].id).toBe('recent');
  });

  it('respecte la limite demandée après retri', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry({ id: `e${i}`, confidenceScore: i / 10 }));
    const { service } = buildService(entries);

    const result = await service.findRelevant({ organizationId: 'org-1', limit: 3 });

    expect(result.length).toBe(3);
  });

  it('chaque résultat porte sa confiance effective, distincte de confidenceScore brut', async () => {
    const oldEntry = entry({ id: 'old', confidenceScore: 0.8, lastObservedAt: new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000) });
    const { service } = buildService([oldEntry]);

    const [result] = await service.findRelevant({ organizationId: 'org-1' });

    expect(result.effectiveConfidence).toBeLessThan(0.8);
  });
});
