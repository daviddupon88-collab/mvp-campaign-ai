import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BrandService } from './brand.service';
import { BrandMemoryQueryService } from './brand-memory-query.service';

export interface BuildContextParams {
  organizationId: string;
  channel?: string;
  persona?: string;
  contentType?: string;
}

export interface BrandBrainContext {
  text: string;
  rules: Array<{ id: string; content: string }>;
  entriesUsed: Array<{ id: string; content: string; effectiveConfidence: number }>;
}

// Limité volontairement (Phase 10/18) : un prompt surchargé de connaissances dilue son
// propre signal et coûte plus de tokens pour un bénéfice décroissant. Les règles ne sont
// PAS soumises à cette même logique de pertinence — une contrainte de marque n'est jamais
// "peut-être oubliée" parce qu'une autre connaissance a une confiance plus élevée.
const MAX_LEARNING_ENTRIES = 6;
const MAX_RULES = 5;

// Fix du bug racine identifié à l'audit du 2026-08-12 : BrandService.buildPromptContext()
// n'était jamais appelé nulle part — cette classe le remplace et est réellement câblée dans
// AiOrchestratorService (cf. Lot D). Contrairement à l'ancienne version ("les 5 dernières
// mémoires"), la sélection se fait maintenant par pertinence/confiance/récence/scope
// (BrandMemoryQueryService), jamais par simple ordre chronologique.
@Injectable()
export class BrandContextBuilderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly brandService: BrandService,
    private readonly queryService: BrandMemoryQueryService,
  ) {}

  async build(params: BuildContextParams): Promise<BrandBrainContext> {
    const kit = await this.brandService.get(params.organizationId);

    const scopeMatch: Array<Record<string, unknown>> = [{ scope: 'GLOBAL' }];
    if (params.channel) scopeMatch.push({ channel: params.channel });
    if (params.persona) scopeMatch.push({ persona: params.persona });

    // Règles (Phase 11) — toujours incluses tant qu'actives, jamais coupées par la limite de
    // pertinence des LEARNING/INSIGHT ci-dessous (cf. constante MAX_RULES ci-dessus, un
    // plafond de sécurité contre une croissance illimitée, pas un filtre de pertinence).
    const rules = await this.prisma.brandMemoryEntry.findMany({
      where: { organizationId: params.organizationId, type: 'RULE', status: 'ACTIVE', OR: scopeMatch },
      orderBy: { confidenceScore: 'desc' },
      take: MAX_RULES,
    });

    const relevant = await this.queryService.findRelevant({
      organizationId: params.organizationId,
      channel: params.channel,
      persona: params.persona,
      contentType: params.contentType,
      limit: MAX_LEARNING_ENTRIES,
    });

    const ruleIds = new Set(rules.map((r) => r.id));
    const nonRuleEntries = relevant.filter((e) => !ruleIds.has(e.id) && e.type !== 'RULE');

    const sections = [
      kit?.mission ? `Mission : ${kit.mission}` : null,
      kit?.vision ? `Vision : ${kit.vision}` : null,
      kit?.toneOfVoice ? `Ton éditorial : ${kit.toneOfVoice}` : null,
      kit?.valueProps ? `Arguments clés : ${JSON.stringify(kit.valueProps)}` : null,
      kit?.slogans ? `Slogans existants : ${JSON.stringify(kit.slogans)}` : null,
      kit?.competitors ? `Concurrents connus : ${JSON.stringify(kit.competitors)}` : null,
      kit?.personaNotes ? `Personas de référence : ${JSON.stringify(kit.personaNotes)}` : null,
      rules.length > 0
        ? `RÈGLES DE MARQUE (contraintes non négociables, à respecter strictement) :\n${rules.map((r) => `- ${r.content}`).join('\n')}`
        : null,
      nonRuleEntries.length > 0
        ? `Apprentissages pertinents des campagnes précédentes :\n${nonRuleEntries.map((e) => `- ${e.content}`).join('\n')}`
        : null,
    ];

    return {
      text: sections.filter(Boolean).join('\n\n'),
      rules: rules.map((r) => ({ id: r.id, content: r.content })),
      entriesUsed: nonRuleEntries.map((e) => ({ id: e.id, content: e.content, effectiveConfidence: e.effectiveConfidence })),
    };
  }
}
