import { BrandBriefService } from './brand-brief.service';
import { PrismaService } from '../prisma/prisma.service';
import { BrandService } from './brand.service';

function entry(overrides: Partial<any>): any {
  return {
    id: 'e', content: 'x', type: 'LEARNING', confidenceScore: 0.5, positiveSignals: 0, negativeSignals: 0,
    channel: null, persona: null, dedupKey: null, lastObservedAt: new Date(), metadata: null,
    ...overrides,
  };
}

function buildService(params: { kit?: any; sample?: any[]; rules?: any[]; contradictionsCount?: number; avgConfidence?: number | null }) {
  const findMany = jest
    .fn()
    .mockResolvedValueOnce(params.sample ?? []) // sample LEARNING/INSIGHT
    .mockResolvedValueOnce(params.rules ?? []); // rules
  const count = jest.fn().mockResolvedValue(params.contradictionsCount ?? 0);
  const aggregate = jest.fn().mockResolvedValue({ _avg: { confidenceScore: params.avgConfidence ?? null } });

  const prisma = {
    brandMemoryEntry: { findMany, aggregate },
    brandMemoryContradiction: { count },
  } as unknown as PrismaService;

  const get = jest.fn().mockResolvedValue(params.kit ?? null);
  const brandService = { get } as unknown as BrandService;

  const service = new BrandBriefService(prisma, brandService);
  return { service };
}

describe('BrandBriefService.buildSummary', () => {
  it('reste vide (jamais inventé) quand une organisation n\'a aucune donnée', async () => {
    const { service } = buildService({});

    const summary = await service.buildSummary('org-1');

    expect(summary.positioning).toBeNull();
    expect(summary.preferredTerms).toEqual([]);
    expect(summary.forbiddenTerms).toEqual([]);
    expect(summary.winningPatterns).toEqual([]);
    expect(summary.losingPatterns).toEqual([]);
    expect(summary.globalConfidenceAverage).toBeNull();
  });

  it('sépare winning et losing patterns selon la dominance positive/négative', async () => {
    const sample = [
      entry({ id: 'win', content: 'Les hooks courts fonctionnent', positiveSignals: 5, negativeSignals: 1, confidenceScore: 0.7 }),
      entry({ id: 'lose', content: "L'intro longue échoue", positiveSignals: 0, negativeSignals: 4, confidenceScore: 0.6 }),
      entry({ id: 'neutral', content: 'Observation neutre', positiveSignals: 0, negativeSignals: 0, confidenceScore: 0.3 }),
    ];
    const { service } = buildService({ sample });

    const summary = await service.buildSummary('org-1');

    expect(summary.winningPatterns.map((p) => p.content)).toEqual(['Les hooks courts fonctionnent']);
    expect(summary.losingPatterns.map((p) => p.content)).toEqual(["L'intro longue échoue"]);
  });

  it('extrait les mots préférés/interdits depuis les observations Content Studio (dedupKey), jamais inventés', async () => {
    const sample = [
      entry({ id: 'a', dedupKey: 'edit-added:instagram:produit' }),
      entry({ id: 'b', dedupKey: 'edit-removed:facebook:revolutionnaire' }),
    ];
    const { service } = buildService({ sample });

    const summary = await service.buildSummary('org-1');

    expect(summary.preferredTerms).toContain('produit');
    expect(summary.forbiddenTerms).toContain('revolutionnaire');
  });

  it('inclut les termes interdits explicites des règles actives (metadata.forbiddenTerms)', async () => {
    const rules = [entry({ id: 'rule-1', type: 'RULE', metadata: { forbiddenTerms: ['garanti', 'miracle'] } })];
    const { service } = buildService({ rules });

    const summary = await service.buildSummary('org-1');

    expect(summary.forbiddenTerms).toEqual(expect.arrayContaining(['garanti', 'miracle']));
  });

  it('agrège la confiance moyenne par canal, triée décroissante', async () => {
    const sample = [
      entry({ id: 'a', channel: 'linkedin', confidenceScore: 0.9 }),
      entry({ id: 'b', channel: 'tiktok', confidenceScore: 0.3 }),
    ];
    const { service } = buildService({ sample });

    const summary = await service.buildSummary('org-1');

    expect(summary.topChannels[0].channel).toBe('linkedin');
  });

  it('reflète le nombre réel de contradictions non résolues, sans les masquer', async () => {
    const { service } = buildService({ contradictionsCount: 3 });

    const summary = await service.buildSummary('org-1');

    expect(summary.contradictionsCount).toBe(3);
  });

  it('utilise mission (puis vision en repli) pour le positionnement, jamais un texte codé en dur', async () => {
    const { service } = buildService({ kit: { mission: 'Rendre le sport accessible', vision: null, toneOfVoice: 'Direct' } });

    const summary = await service.buildSummary('org-1');

    expect(summary.positioning).toBe('Rendre le sport accessible');
    expect(summary.toneOfVoice).toBe('Direct');
  });
});
