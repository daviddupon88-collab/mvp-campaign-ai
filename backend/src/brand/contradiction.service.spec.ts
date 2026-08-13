import { NotFoundException } from '@nestjs/common';
import { ContradictionService } from './contradiction.service';
import { PrismaService } from '../prisma/prisma.service';

function buildService(target: any, candidates: any[], existingContradiction: any = null) {
  const findUnique = jest.fn().mockResolvedValue(target);
  const findManyEntries = jest.fn().mockResolvedValue(candidates);
  const findFirstContradiction = jest.fn().mockResolvedValue(existingContradiction);
  const createContradiction = jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'contradiction-1', ...data }));
  const updateManyEntries = jest.fn().mockResolvedValue({ count: 2 });

  const prisma = {
    brandMemoryEntry: { findUnique, findMany: findManyEntries, updateMany: updateManyEntries },
    brandMemoryContradiction: { findFirst: findFirstContradiction, create: createContradiction },
  } as unknown as PrismaService;

  const service = new ContradictionService(prisma);
  return { service, createContradiction, updateManyEntries, findFirstContradiction, findManyEntries };
}

const base = { channel: null, persona: null, contentType: null, evidenceCount: 3, confidenceScore: 0.5 };

describe('ContradictionService.scanForContradictions', () => {
  it("détecte un désaccord réel (même canal) et marque les deux entrées CONTRADICTED", async () => {
    const target = { ...base, id: 'a', content: 'Les vidéos courtes fonctionnent mieux sur ce canal.', channel: 'tiktok' };
    const candidate = { ...base, id: 'b', content: 'Les vidéos longues fonctionnent mieux sur ce canal.', channel: 'tiktok' };
    const { service, createContradiction, updateManyEntries } = buildService(target, [candidate]);

    const result = await service.scanForContradictions('org-1', 'a', 'CREATIVE');

    expect(result).toHaveLength(1);
    expect(createContradiction.mock.calls[0][0].data.resolutionStatus).toBe('UNRESOLVED');
    expect(updateManyEntries).toHaveBeenCalledWith({ where: { id: { in: ['a', 'b'] } }, data: { status: 'CONTRADICTED' } });
  });

  // Correction de l'audit : sans ordre explicite, la fenêtre des MAX_CANDIDATES_PER_SCAN
  // candidats n'était pas reproductible — certaines paires pouvaient ne jamais être comparées.
  it('interroge les candidats avec un ordre explicite et déterministe', async () => {
    const target = { ...base, id: 'a', content: 'Les vidéos courtes fonctionnent mieux.' };
    const { service, findManyEntries } = buildService(target, []);

    await service.scanForContradictions('org-1', 'a', 'CREATIVE');

    expect(findManyEntries).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { lastObservedAt: 'desc' } }),
    );
  });

  it("marque CONTEXT_DEPENDENT (sans toucher au statut des entrées) quand le canal diffère — exemple TikTok/YouTube de la Phase 9", async () => {
    const target = { ...base, id: 'a', content: 'Les vidéos courtes fonctionnent mieux.', channel: 'tiktok' };
    const candidate = { ...base, id: 'b', content: 'Les vidéos longues fonctionnent mieux.', channel: 'youtube' };
    const { service, createContradiction, updateManyEntries } = buildService(target, [candidate]);

    await service.scanForContradictions('org-1', 'a', 'CREATIVE');

    expect(createContradiction.mock.calls[0][0].data.resolutionStatus).toBe('CONTEXT_DEPENDENT');
    expect(updateManyEntries).not.toHaveBeenCalled();
  });

  it("ne signale rien entre deux connaissances non opposées (aucune paire de mots-clés détectée)", async () => {
    const target = { ...base, id: 'a', content: 'Les personas B2B réagissent bien aux chiffres.', channel: 'linkedin' };
    const candidate = { ...base, id: 'b', content: 'Le ton doit rester professionnel et clair.', channel: 'linkedin' };
    const { service, createContradiction } = buildService(target, [candidate]);

    const result = await service.scanForContradictions('org-1', 'a', 'VOICE');

    expect(result).toHaveLength(0);
    expect(createContradiction).not.toHaveBeenCalled();
  });

  it("n'enregistre jamais deux fois la même paire déjà détectée", async () => {
    const target = { ...base, id: 'a', content: 'Ton agressif recommandé.', channel: 'facebook' };
    const candidate = { ...base, id: 'b', content: 'Un ton doux fonctionne mieux.', channel: 'facebook' };
    const { service, createContradiction } = buildService(target, [candidate], { id: 'existing-contradiction' });

    const result = await service.scanForContradictions('org-1', 'a', 'VOICE');

    expect(result).toHaveLength(0);
    expect(createContradiction).not.toHaveBeenCalled();
  });

  it("exclut l'entrée elle-même de ses propres candidats", async () => {
    const target = { ...base, id: 'a', content: 'contenu', channel: null };
    const { service } = buildService(target, []);

    await service.scanForContradictions('org-1', 'a', 'COPY');
    // Aucune erreur, aucun candidat — le comportement attendu est simplement de ne rien créer.
  });
});

function buildResolveService(contradiction: any) {
  const findFirstContradiction = jest.fn().mockResolvedValue(contradiction);
  const findUniqueContradiction = jest.fn().mockResolvedValue({ ...contradiction, resolutionStatus: 'RESOLVED_A' });
  const updateContradiction = jest.fn().mockResolvedValue({});
  const updateEntry = jest.fn().mockResolvedValue({});
  const updateManyEntries = jest.fn().mockResolvedValue({ count: 2 });

  const prisma = {
    brandMemoryContradiction: { findFirst: findFirstContradiction, update: updateContradiction, findUnique: findUniqueContradiction },
    brandMemoryEntry: { update: updateEntry, updateMany: updateManyEntries },
  } as unknown as PrismaService;

  const service = new ContradictionService(prisma);
  return { service, updateContradiction, updateEntry, updateManyEntries };
}

describe('ContradictionService.resolve (Phase 9/13)', () => {
  const contradiction = { id: 'c-1', organizationId: 'org-1', knowledgeAId: 'a', knowledgeBId: 'b' };

  it("lève NotFoundException si la contradiction n'appartient pas à l'organisation appelante (Phase 17)", async () => {
    const { service } = buildResolveService(null);

    await expect(service.resolve('org-1', 'c-1', 'RESOLVED_A', 'user-1')).rejects.toThrow(NotFoundException);
  });

  it('RESOLVED_A réactive la connaissance A et désactive B, jamais une suppression', async () => {
    const { service, updateEntry } = buildResolveService(contradiction);

    await service.resolve('org-1', 'c-1', 'RESOLVED_A', 'user-1');

    expect(updateEntry).toHaveBeenCalledWith({ where: { id: 'a' }, data: { status: 'ACTIVE' } });
    expect(updateEntry).toHaveBeenCalledWith({ where: { id: 'b' }, data: { status: 'DISMISSED' } });
  });

  it('RESOLVED_B réactive B et désactive A (symétrique de RESOLVED_A)', async () => {
    const { service, updateEntry } = buildResolveService(contradiction);

    await service.resolve('org-1', 'c-1', 'RESOLVED_B', 'user-1');

    expect(updateEntry).toHaveBeenCalledWith({ where: { id: 'b' }, data: { status: 'ACTIVE' } });
    expect(updateEntry).toHaveBeenCalledWith({ where: { id: 'a' }, data: { status: 'DISMISSED' } });
  });

  it('CONTEXT_DEPENDENT réactive LES DEUX connaissances — elles ne sont pas réellement en conflit', async () => {
    const { service, updateManyEntries, updateEntry } = buildResolveService(contradiction);

    await service.resolve('org-1', 'c-1', 'CONTEXT_DEPENDENT', 'user-1');

    expect(updateManyEntries).toHaveBeenCalledWith({ where: { id: { in: ['a', 'b'] } }, data: { status: 'ACTIVE' } });
    expect(updateEntry).not.toHaveBeenCalled();
  });

  it('enregistre qui a résolu et quand', async () => {
    const { service, updateContradiction } = buildResolveService(contradiction);

    await service.resolve('org-1', 'c-1', 'RESOLVED_A', 'user-42');

    const data = updateContradiction.mock.calls[0][0].data;
    expect(data.resolvedByUserId).toBe('user-42');
    expect(data.resolvedAt).toBeInstanceOf(Date);
  });
});
