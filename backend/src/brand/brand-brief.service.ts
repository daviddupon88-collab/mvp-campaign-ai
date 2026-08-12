import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BrandService } from './brand.service';

export interface BrandBriefSummary {
  positioning: string | null;
  toneOfVoice: string | null;
  preferredTerms: string[];
  forbiddenTerms: string[];
  winningPatterns: Array<{ content: string; confidenceScore: number }>;
  losingPatterns: Array<{ content: string; confidenceScore: number }>;
  topChannels: Array<{ channel: string; averageConfidence: number; entryCount: number }>;
  topPersonas: Array<{ persona: string; averageConfidence: number; entryCount: number }>;
  recentLearnings: Array<{ content: string; type: string; lastObservedAt: Date }>;
  contradictionsCount: number;
  globalConfidenceAverage: number | null;
}

// Bornage volontaire (Phase 18) : jamais toute la mémoire d'une organisation en une seule
// requête — un échantillon suffisant pour un résumé reste borné, contrairement au contexte
// de génération (BrandContextBuilderService) qui a ses propres limites indépendantes.
const SAMPLE_SIZE = 100;
const TOP_N = 5;

// Phase 12 — résumé dynamique généré à partir des données réelles, jamais de valeurs codées
// en dur : si une organisation n'a pas encore assez de données, les sections correspondantes
// restent simplement vides plutôt que remplies arbitrairement.
@Injectable()
export class BrandBriefService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly brandService: BrandService,
  ) {}

  async buildSummary(organizationId: string): Promise<BrandBriefSummary> {
    const [kit, sample, rules, contradictionsCount, confidenceAggregate] = await Promise.all([
      this.brandService.get(organizationId),
      this.prisma.brandMemoryEntry.findMany({
        where: { organizationId, status: 'ACTIVE', type: { in: ['LEARNING', 'INSIGHT'] } },
        orderBy: { confidenceScore: 'desc' },
        take: SAMPLE_SIZE,
      }),
      this.prisma.brandMemoryEntry.findMany({
        where: { organizationId, status: 'ACTIVE', type: 'RULE' },
      }),
      this.prisma.brandMemoryContradiction.count({ where: { organizationId, resolutionStatus: 'UNRESOLVED' } }),
      this.prisma.brandMemoryEntry.aggregate({ where: { organizationId, status: 'ACTIVE' }, _avg: { confidenceScore: true } }),
    ]);

    const winningPatterns = sample
      .filter((e) => e.positiveSignals > e.negativeSignals)
      .slice(0, TOP_N)
      .map((e) => ({ content: e.content, confidenceScore: e.confidenceScore }));

    const losingPatterns = sample
      .filter((e) => e.negativeSignals > e.positiveSignals)
      .slice(0, TOP_N)
      .map((e) => ({ content: e.content, confidenceScore: e.confidenceScore }));

    // Mots préférés/interdits (Phase 12) : dérivés des observations d'édition Content Studio
    // (cf. Lot B — dedupKey "edit-added:*"/"edit-removed:*"), jamais inventés. Les termes
    // explicitement interdits par une RULE (metadata.forbiddenTerms) complètent la liste.
    const preferredTerms = this.extractDedupTerm(sample, 'edit-added:');
    const forbiddenFromEdits = this.extractDedupTerm(sample, 'edit-removed:');
    const forbiddenFromRules = rules.flatMap((r) => (r.metadata as { forbiddenTerms?: string[] } | null)?.forbiddenTerms ?? []);
    const forbiddenTerms = [...new Set([...forbiddenFromRules, ...forbiddenFromEdits])];

    const topChannels = this.aggregateByChannel(sample);
    const topPersonas = this.aggregateByPersona(sample);

    const recentLearnings = [...sample]
      .sort((a, b) => b.lastObservedAt.getTime() - a.lastObservedAt.getTime())
      .slice(0, TOP_N)
      .map((e) => ({ content: e.content, type: e.type, lastObservedAt: e.lastObservedAt }));

    return {
      positioning: kit?.mission ?? kit?.vision ?? null,
      toneOfVoice: kit?.toneOfVoice ?? null,
      preferredTerms,
      forbiddenTerms,
      winningPatterns,
      losingPatterns,
      topChannels,
      topPersonas,
      recentLearnings,
      contradictionsCount,
      globalConfidenceAverage: confidenceAggregate._avg.confidenceScore,
    };
  }

  private extractDedupTerm(entries: Array<{ dedupKey: string | null }>, prefix: string): string[] {
    return [
      ...new Set(
        entries
          .filter((e) => e.dedupKey?.startsWith(prefix))
          .map((e) => e.dedupKey!.split(':').pop())
          .filter((term): term is string => Boolean(term)),
      ),
    ].slice(0, TOP_N);
  }

  private groupConfidenceBy(entries: Array<{ key: string | null; confidenceScore: number }>): Array<{ key: string; averageConfidence: number; entryCount: number }> {
    const groups = new Map<string, number[]>();
    for (const entry of entries) {
      if (!entry.key) continue;
      if (!groups.has(entry.key)) groups.set(entry.key, []);
      groups.get(entry.key)!.push(entry.confidenceScore);
    }

    return [...groups.entries()]
      .map(([key, scores]) => ({
        key,
        averageConfidence: Math.round((scores.reduce((s, v) => s + v, 0) / scores.length) * 1000) / 1000,
        entryCount: scores.length,
      }))
      .sort((a, b) => b.averageConfidence - a.averageConfidence)
      .slice(0, TOP_N);
  }

  private aggregateByChannel(entries: Array<{ channel: string | null; confidenceScore: number }>): BrandBriefSummary['topChannels'] {
    return this.groupConfidenceBy(entries.map((e) => ({ key: e.channel, confidenceScore: e.confidenceScore }))).map((g) => ({
      channel: g.key,
      averageConfidence: g.averageConfidence,
      entryCount: g.entryCount,
    }));
  }

  private aggregateByPersona(entries: Array<{ persona: string | null; confidenceScore: number }>): BrandBriefSummary['topPersonas'] {
    return this.groupConfidenceBy(entries.map((e) => ({ key: e.persona, confidenceScore: e.confidenceScore }))).map((g) => ({
      persona: g.key,
      averageConfidence: g.averageConfidence,
      entryCount: g.entryCount,
    }));
  }
}
