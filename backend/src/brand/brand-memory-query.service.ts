import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BrandMemoryCategory } from '@prisma/client';
import { computeEffectiveConfidence } from './temporal-decay.util';

export interface FindRelevantParams {
  organizationId: string;
  channel?: string;
  persona?: string;
  contentType?: string;
  category?: BrandMemoryCategory;
  limit?: number;
}

// Primitive de sélection par pertinence (Phases 6/7) — consommée par le futur Context
// Builder (Lot D) plutôt que d'y dupliquer cette logique. Une connaissance est retenue si
// elle est GLOBALE (s'applique partout) OU si elle correspond explicitement à l'axe demandé
// (canal/persona/type de contenu) — jamais l'inverse : une connaissance spécifique à
// LinkedIn n'est jamais retournée pour une requête TikTok (cf. Phase 6, exemple "ton
// professionnel" qui n'a pas la même valeur selon le canal).
@Injectable()
export class BrandMemoryQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async findRelevant(params: FindRelevantParams) {
    const limit = params.limit ?? 20;

    const scopeMatch: Array<Record<string, unknown>> = [{ scope: 'GLOBAL' }];
    if (params.channel) scopeMatch.push({ scope: 'CHANNEL', channel: params.channel });
    if (params.persona) scopeMatch.push({ scope: 'PERSONA', persona: params.persona });
    if (params.contentType) scopeMatch.push({ scope: 'CONTENT_TYPE', contentType: params.contentType });

    // En dehors du scope lui-même, channel/persona/contentType peuvent aussi affiner une
    // entrée de portée plus large (ex: scope=CAMPAIGN avec channel renseigné en plus) — donc
    // on élargit également sur une correspondance directe de ces champs, pas seulement sur
    // le scope déclaré.
    if (params.channel) scopeMatch.push({ channel: params.channel });
    if (params.persona) scopeMatch.push({ persona: params.persona });
    if (params.contentType) scopeMatch.push({ contentType: params.contentType });

    const entries = await this.prisma.brandMemoryEntry.findMany({
      where: {
        organizationId: params.organizationId,
        status: 'ACTIVE', // jamais CONTRADICTED/DISMISSED/OUTDATED — cf. Phase 9 et Phase 11
        ...(params.category ? { category: params.category } : {}),
        OR: scopeMatch,
      },
      // Sur-sélectionné puis retrié par confiance effective (avec décroissance) — le tri SQL
      // seul ne peut pas exprimer la décroissance temporelle qui dépend de "maintenant".
      take: limit * 3,
    });

    const now = new Date();
    return entries
      .map((entry) => ({ entry, effectiveConfidence: computeEffectiveConfidence(entry.confidenceScore, entry.lastObservedAt, now) }))
      .sort((a, b) => b.effectiveConfidence - a.effectiveConfidence)
      .slice(0, limit)
      .map(({ entry, effectiveConfidence }) => ({ ...entry, effectiveConfidence }));
  }
}
