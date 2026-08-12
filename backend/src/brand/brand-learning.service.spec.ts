import { NotFoundException } from '@nestjs/common';
import { BrandLearningService } from './brand-learning.service';
import { PrismaService } from '../prisma/prisma.service';
import { ContradictionService } from './contradiction.service';

function buildService(existing: any = null) {
  const findFirst = jest.fn().mockResolvedValue(existing);
  const create = jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'entry-new', ...data }));
  const update = jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: existing?.id, ...existing, ...data }));

  const prisma = {
    brandMemoryEntry: { findFirst, create, update },
  } as unknown as PrismaService;

  const scanForContradictions = jest.fn().mockResolvedValue([]);
  const contradictions = { scanForContradictions } as unknown as ContradictionService;

  const service = new BrandLearningService(prisma, contradictions);
  return { service, findFirst, create, update, scanForContradictions };
}

// Vérifie le cœur de la Phase 3 : une observation isolée ne doit jamais produire une
// confiance élevée, même si elle est 100% positive — sans quoi une campagne qui performe
// bien une seule fois deviendrait à tort une RULE à confiance élevée.
describe('BrandLearningService.computeConfidence', () => {
  it('reste basse pour une observation unique, même entièrement positive', () => {
    const { service } = buildService();
    const score = service.computeConfidence({ evidenceCount: 1, positiveSignals: 1, negativeSignals: 0 });
    expect(score).toBeLessThan(0.35);
    expect(score).toBeGreaterThan(0); // jamais nulle : l'observation existe bel et bien
  });

  it('augmente avec des observations répétées et cohérentes', () => {
    const { service } = buildService();
    const one = service.computeConfidence({ evidenceCount: 1, positiveSignals: 1, negativeSignals: 0 });
    const three = service.computeConfidence({ evidenceCount: 3, positiveSignals: 3, negativeSignals: 0 });
    const eight = service.computeConfidence({ evidenceCount: 8, positiveSignals: 8, negativeSignals: 0 });
    expect(three).toBeGreaterThan(one);
    expect(eight).toBeGreaterThan(three);
  });

  it("plafonne l'effet du volume au-delà du seuil de saturation", () => {
    const { service } = buildService();
    const eight = service.computeConfidence({ evidenceCount: 8, positiveSignals: 8, negativeSignals: 0 });
    const twenty = service.computeConfidence({ evidenceCount: 20, positiveSignals: 20, negativeSignals: 0 });
    expect(twenty).toBeCloseTo(eight, 2);
  });

  it('pénalise un signal incohérent (positifs et négatifs mélangés) même avec beaucoup de volume', () => {
    const { service } = buildService();
    const consistent = service.computeConfidence({ evidenceCount: 8, positiveSignals: 8, negativeSignals: 0 });
    const mixed = service.computeConfidence({ evidenceCount: 8, positiveSignals: 4, negativeSignals: 4 });
    expect(mixed).toBeLessThan(consistent);
  });

  it("reste neutre (ni pénalisée ni favorisée) quand aucun signal de polarité n'est suivi", () => {
    const { service } = buildService();
    // Cas des observations d'édition Content Studio : un fait constaté, pas un succès/échec.
    const score = service.computeConfidence({ evidenceCount: 4, positiveSignals: 0, negativeSignals: 0 });
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('reste toujours dans les bornes [0, 1]', () => {
    const { service } = buildService();
    expect(service.computeConfidence({ evidenceCount: 0, positiveSignals: 0, negativeSignals: 0 })).toBeGreaterThanOrEqual(0);
    expect(service.computeConfidence({ evidenceCount: 1000, positiveSignals: 1000, negativeSignals: 0 })).toBeLessThanOrEqual(1);
  });
});

describe('BrandLearningService.recordObservation', () => {
  it("crée une nouvelle entrée quand aucune correspondance (dedupKey) n'existe", async () => {
    const { service, create } = buildService(null);

    await service.recordObservation({
      organizationId: 'org-1',
      content: 'Le mot « révolutionnaire » est régulièrement retiré.',
      dedupKey: 'edit-removed:facebook:revolutionnaire',
      signal: 'positive',
      source: 'content_studio_edit',
    });

    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0][0].data;
    expect(data.evidenceCount).toBe(1);
    expect(data.positiveSignals).toBe(1);
    expect(data.type).toBe('LEARNING'); // valeur par défaut — jamais RULE sur une 1ère observation
  });

  it('renforce (ne duplique pas) une entrée existante partageant la même dedupKey', async () => {
    const existing = {
      id: 'entry-1',
      evidenceCount: 2,
      positiveSignals: 2,
      negativeSignals: 0,
      sampleSize: null,
    };
    const { service, create, update } = buildService(existing);

    await service.recordObservation({
      organizationId: 'org-1',
      content: 'Le mot « révolutionnaire » est régulièrement retiré.',
      dedupKey: 'edit-removed:facebook:revolutionnaire',
      signal: 'positive',
      source: 'content_studio_edit',
    });

    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    const data = update.mock.calls[0][0].data;
    expect(data.evidenceCount).toBe(3);
    expect(data.positiveSignals).toBe(3);
  });

  it('recalcule la confiance à chaque renforcement (elle doit augmenter avec la répétition)', async () => {
    const existing = { id: 'entry-1', evidenceCount: 1, positiveSignals: 1, negativeSignals: 0, sampleSize: null };
    const { service, update } = buildService(existing);

    await service.recordObservation({
      organizationId: 'org-1',
      content: 'contenu',
      dedupKey: 'k',
      signal: 'positive',
      source: 'content_studio_edit',
    });

    const initialConfidence = service.computeConfidence({ evidenceCount: 1, positiveSignals: 1, negativeSignals: 0 });
    const updatedConfidence = update.mock.calls[0][0].data.confidenceScore;
    expect(updatedConfidence).toBeGreaterThan(initialConfidence);
  });

  it('déclenche le scan de contradictions quand une catégorie est renseignée', async () => {
    const { service, scanForContradictions } = buildService(null);

    await service.recordObservation({
      organizationId: 'org-1',
      category: 'COPY',
      content: 'contenu',
      dedupKey: 'k',
      source: 'content_studio_edit',
    });

    expect(scanForContradictions).toHaveBeenCalledWith('org-1', 'entry-new', 'COPY');
  });

  it("ne déclenche jamais le scan de contradictions sans catégorie identifiable (Phase 9 : jamais au hasard)", async () => {
    const { service, scanForContradictions } = buildService(null);

    await service.recordObservation({ organizationId: 'org-1', content: 'contenu', dedupKey: 'k', source: 'content_studio_edit' });

    expect(scanForContradictions).not.toHaveBeenCalled();
  });

  it("n'échoue jamais l'enregistrement d'une observation si le scan de contradictions échoue (best-effort)", async () => {
    const { service, scanForContradictions, create } = buildService(null);
    scanForContradictions.mockRejectedValue(new Error('panne'));

    await expect(
      service.recordObservation({ organizationId: 'org-1', category: 'COPY', content: 'contenu', dedupKey: 'k', source: 'content_studio_edit' }),
    ).resolves.toBeDefined();
    expect(create).toHaveBeenCalled();
  });
});

// Phase 17 (CRITIQUE) : toute mutation doit être scoppée par organizationId — une entrée
// appartenant à une autre organisation ne doit jamais être trouvable, même avec un id valide.
describe('BrandLearningService — isolation multi-tenant sur les mutations', () => {
  it.each(['confirmEntry', 'dismissEntry', 'promoteToRule', 'correctEntry'] as const)(
    '%s lève NotFoundException si l\'entrée n\'appartient pas à l\'organisation appelante',
    async (method) => {
      const { service } = buildService(null); // findFirst résout null => pas trouvée pour CETTE organisation

      await expect((service[method] as any)('org-1', 'entry-1', {})).rejects.toThrow(NotFoundException);
    },
  );
});

describe('BrandLearningService.confirmEntry (Phase 13)', () => {
  it('incrémente evidenceCount/positiveSignals et recalcule la confiance — jamais fixée arbitrairement à 1', async () => {
    const existing = { id: 'entry-1', evidenceCount: 2, positiveSignals: 1, negativeSignals: 0, sampleSize: null };
    const { service, update } = buildService(existing);

    await service.confirmEntry('org-1', 'entry-1');

    const data = update.mock.calls[0][0].data;
    expect(data.evidenceCount).toBe(3);
    expect(data.positiveSignals).toBe(2);
    expect(data.confidenceScore).toBe(service.computeConfidence({ evidenceCount: 3, positiveSignals: 2, negativeSignals: 0, sampleSize: null }));
  });
});

describe('BrandLearningService.dismissEntry (Phase 13)', () => {
  it('passe le statut à DISMISSED, jamais une suppression', async () => {
    const existing = { id: 'entry-1' };
    const { service, update } = buildService(existing);

    await service.dismissEntry('org-1', 'entry-1');

    expect(update).toHaveBeenCalledWith({ where: { id: 'entry-1' }, data: { status: 'DISMISSED' } });
  });
});

describe('BrandLearningService.promoteToRule (Phase 11/13)', () => {
  it('change le type en RULE et fusionne forbiddenTerms dans metadata sans écraser le reste', async () => {
    const existing = { id: 'entry-1', metadata: { dedupKey: 'edit-removed:facebook:revolutionnaire' } };
    const { service, update } = buildService(existing);

    await service.promoteToRule('org-1', 'entry-1', ['garanti', 'miracle']);

    const data = update.mock.calls[0][0].data;
    expect(data.type).toBe('RULE');
    expect(data.metadata).toEqual({ dedupKey: 'edit-removed:facebook:revolutionnaire', forbiddenTerms: ['garanti', 'miracle'] });
  });

  it('reste promouvable sans forbiddenTerms (règle appliquée seulement au niveau du prompt)', async () => {
    const existing = { id: 'entry-1', metadata: null };
    const { service, update } = buildService(existing);

    await service.promoteToRule('org-1', 'entry-1');

    expect(update.mock.calls[0][0].data.type).toBe('RULE');
    expect(update.mock.calls[0][0].data.metadata).toEqual({});
  });
});

describe('BrandLearningService.correctEntry (Phase 13)', () => {
  it('ne modifie que les champs fournis', async () => {
    const existing = { id: 'entry-1', content: 'ancien texte', category: 'COPY' };
    const { service, update } = buildService(existing);

    await service.correctEntry('org-1', 'entry-1', { content: 'texte corrigé' });

    expect(update).toHaveBeenCalledWith({ where: { id: 'entry-1' }, data: { content: 'texte corrigé' } });
  });
});
