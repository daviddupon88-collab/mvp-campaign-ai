import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BrandMemoryCategory, ContradictionResolutionStatus } from '@prisma/client';
import { normalizeWord } from '../content-studio/edit-diff.util';

// Détection HEURISTIQUE par paires de mots-clés opposés — volontairement limitée, pas de
// compréhension sémantique réelle (cf. rapport d'audit, limitation connue assumée pour rester
// sans appel IA à chaque écriture). Chaque paire est [groupeA, groupeB] : un contenu qui
// contient un mot du groupeA et un autre contenu qui contient un mot du groupeB, sur la même
// catégorie, sont candidats à une contradiction. Liste illustrative, non exhaustive — une
// vraie extraction sémantique (via AI Gateway) est une évolution V3 raisonnable si le volume
// de connaissances le justifie.
const OPPOSING_TERM_PAIRS: Array<[string[], string[]]> = [
  [['court', 'courte', 'courtes', 'courts', 'breve', 'breves', 'concis', 'concise'], ['long', 'longue', 'longues', 'longs']],
  [['agressif', 'agressive', 'insistant', 'insistante'], ['doux', 'douce', 'subtil', 'subtile', 'sobre']],
  [['excessif', 'excessive', 'exagere', 'exageree'], ['modere', 'moderee', 'mesure', 'mesuree']],
  [['formel', 'formelle'], ['informel', 'informelle', 'decontracte', 'decontractee', 'casual']],
  [['cher', 'chere', 'premium', 'haut de gamme'], ['abordable', 'economique', 'bon marche']],
  [['video', 'videos'], ['image', 'images', 'photo', 'photos', 'statique']],
];

function findOpposingPair(contentA: string, contentB: string): boolean {
  const wordsA = new Set(contentA.split(/\s+/).map(normalizeWord));
  const wordsB = new Set(contentB.split(/\s+/).map(normalizeWord));

  return OPPOSING_TERM_PAIRS.some(
    ([groupA, groupB]) =>
      (groupA.some((w) => wordsA.has(w)) && groupB.some((w) => wordsB.has(w))) ||
      (groupB.some((w) => wordsA.has(w)) && groupA.some((w) => wordsB.has(w))),
  );
}

// Deux connaissances comparables (même catégorie) mais dont le canal/persona/type de contenu
// diffère ne sont pas un vrai conflit — elles coexistent (cf. exemple TikTok/YouTube de la
// Phase 9). Seule une correspondance EXACTE de ces trois axes constitue un désaccord réel
// nécessitant une résolution humaine.
function sameScopeAxis(a: { channel: string | null; persona: string | null; contentType: string | null }, b: typeof a): boolean {
  return a.channel === b.channel && a.persona === b.persona && a.contentType === b.contentType;
}

// Borne le nombre de comparaisons par catégorie — un scan complet par paire est acceptable
// tant que le volume par catégorie reste modeste (cf. Phase 18, éviter les requêtes lourdes).
const MAX_CANDIDATES_PER_SCAN = 30;

@Injectable()
export class ContradictionService {
  private readonly logger = new Logger(ContradictionService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Compare une entrée fraîchement écrite/renforcée aux autres connaissances ACTIVES de la
  // même catégorie — jamais un scan de toute l'organisation à chaque écriture (Phase 18).
  async scanForContradictions(organizationId: string, entryId: string, category: BrandMemoryCategory) {
    const [target, candidates] = await Promise.all([
      this.prisma.brandMemoryEntry.findUnique({ where: { id: entryId } }),
      this.prisma.brandMemoryEntry.findMany({
        where: { organizationId, category, status: 'ACTIVE', id: { not: entryId } },
        // Correction de l'audit : sans orderBy explicite, l'ordre renvoyé par Postgres n'est
        // pas garanti stable — au-delà de MAX_CANDIDATES_PER_SCAN entrées ACTIVE dans une
        // catégorie, certaines paires pouvaient ne jamais être comparées de façon
        // reproductible. Priorité aux connaissances renforcées le plus récemment, les plus
        // susceptibles d'être pertinentes pour une contradiction avec une entrée fraîche.
        orderBy: { lastObservedAt: 'desc' },
        take: MAX_CANDIDATES_PER_SCAN,
      }),
    ]);
    if (!target) return [];

    const created: Array<Awaited<ReturnType<PrismaService['brandMemoryContradiction']['create']>>> = [];
    for (const candidate of candidates) {
      if (!findOpposingPair(target.content, candidate.content)) continue;

      const alreadyRecorded = await this.prisma.brandMemoryContradiction.findFirst({
        where: {
          organizationId,
          OR: [
            { knowledgeAId: target.id, knowledgeBId: candidate.id },
            { knowledgeAId: candidate.id, knowledgeBId: target.id },
          ],
        },
      });
      if (alreadyRecorded) continue;

      const resolutionStatus = sameScopeAxis(target, candidate) ? 'UNRESOLVED' : 'CONTEXT_DEPENDENT';

      const contradiction = await this.prisma.brandMemoryContradiction.create({
        data: {
          organizationId,
          knowledgeAId: target.id,
          knowledgeBId: candidate.id,
          evidenceA: target.evidenceCount,
          evidenceB: candidate.evidenceCount,
          confidenceA: target.confidenceScore,
          confidenceB: candidate.confidenceScore,
          resolutionStatus,
        },
      });

      // Seul un désaccord réel (même canal/persona/type de contenu) marque les deux entrées
      // CONTRADICTED — jamais pour un cas context-dependent, où les deux connaissances
      // restent pleinement valables chacune dans leur contexte propre.
      if (resolutionStatus === 'UNRESOLVED') {
        await this.prisma.brandMemoryEntry.updateMany({
          where: { id: { in: [target.id, candidate.id] } },
          data: { status: 'CONTRADICTED' },
        });
      }

      this.logger.log(
        `Contradiction ${resolutionStatus === 'UNRESOLVED' ? 'détectée' : 'context-dependent'} entre ${target.id} et ${candidate.id} (catégorie ${category})`,
      );
      created.push(contradiction);
    }

    return created;
  }

  async listContradictions(organizationId: string, status?: ContradictionResolutionStatus) {
    return this.prisma.brandMemoryContradiction.findMany({
      where: { organizationId, ...(status ? { resolutionStatus: status } : {}) },
      include: { knowledgeA: true, knowledgeB: true },
      orderBy: { detectedAt: 'desc' },
    });
  }

  // Phase 9/13 — résolution humaine explicite. RESOLVED_A/RESOLVED_B réactive la connaissance
  // retenue et désactive l'autre (jamais supprimée, cf. règle absolue #4) ; CONTEXT_DEPENDENT
  // réactive les deux, qui n'étaient en réalité pas en conflit (cf. exemple TikTok/YouTube).
  async resolve(organizationId: string, contradictionId: string, resolution: ContradictionResolutionStatus, userId: string) {
    const contradiction = await this.prisma.brandMemoryContradiction.findFirst({ where: { id: contradictionId, organizationId } });
    if (!contradiction) throw new NotFoundException('Contradiction introuvable');

    await this.prisma.brandMemoryContradiction.update({
      where: { id: contradictionId },
      data: { resolutionStatus: resolution, resolvedAt: new Date(), resolvedByUserId: userId },
    });

    if (resolution === 'CONTEXT_DEPENDENT') {
      await this.prisma.brandMemoryEntry.updateMany({
        where: { id: { in: [contradiction.knowledgeAId, contradiction.knowledgeBId] } },
        data: { status: 'ACTIVE' },
      });
    } else {
      const winnerId = resolution === 'RESOLVED_A' ? contradiction.knowledgeAId : contradiction.knowledgeBId;
      const loserId = resolution === 'RESOLVED_A' ? contradiction.knowledgeBId : contradiction.knowledgeAId;
      await this.prisma.brandMemoryEntry.update({ where: { id: winnerId }, data: { status: 'ACTIVE' } });
      await this.prisma.brandMemoryEntry.update({ where: { id: loserId }, data: { status: 'DISMISSED' } });
    }

    return this.prisma.brandMemoryContradiction.findUnique({ where: { id: contradictionId } });
  }
}
