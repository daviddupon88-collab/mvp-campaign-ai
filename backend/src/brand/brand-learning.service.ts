import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BrandMemoryCategory, BrandMemoryScope, BrandMemoryType } from '@prisma/client';
import { ContradictionService } from './contradiction.service';

export interface CorrectEntryParams {
  content?: string;
  category?: BrandMemoryCategory;
  scope?: BrandMemoryScope;
  channel?: string;
  persona?: string;
  contentType?: string;
}

export interface ConfidenceSignals {
  evidenceCount: number;
  positiveSignals: number;
  negativeSignals: number;
  sampleSize?: number | null;
}

// Combien d'observations avant que la répétition du signal cesse d'augmenter la confiance —
// au-delà, seule la cohérence (positif/négatif) continue de compter. Choisi comme repère
// raisonnable plutôt que dérivé d'une donnée réelle : à ajuster une fois qu'assez de volume
// réel aura circulé pour le recalibrer (cf. limitations connues du rapport d'audit).
const EVIDENCE_SATURATION = 8;

// Plancher : une observation unique n'est jamais à confiance nulle (elle EXISTE), mais ne
// doit jamais non plus friser la confiance d'une RULE établie — cf. Phase 3 de la demande :
// "une campagne qui performe très fois doit produire un LEARNING à confiance faible, pas une
// RULE à confiance élevée".
const CONFIDENCE_FLOOR = 0.1;

export interface RecordObservationParams {
  organizationId: string;
  type?: BrandMemoryType; // LEARNING par défaut — une observation n'est jamais promue RULE ici
  category?: BrandMemoryCategory;
  scope?: BrandMemoryScope;
  channel?: string;
  persona?: string;
  contentType?: string;
  content: string;
  // Clé de regroupement : deux observations partageant la même dedupKey (même organisation)
  // renforcent la MÊME entrée (evidenceCount++) plutôt que d'en créer une nouvelle à chaque
  // fois — c'est ce qui matérialise "répétition du signal" (Phase 3) sans nécessiter de
  // comparaison sémantique coûteuse (aucun appel IA ici, cf. edit-diff.util.ts).
  dedupKey: string;
  signal?: 'positive' | 'negative' | 'neutral';
  sampleSize?: number;
  source: string;
  sourceId?: string;
  sourceCampaignId?: string;
}

// Moteur de confiance du Brand Brain (Phase 3) — jamais de RULE à confiance élevée sur une
// observation isolée. Distinct de la décroissance temporelle (Phase 8, lot C) : ce service
// calcule une confiance À L'ÉCRITURE à partir du volume et de la cohérence des signaux ;
// l'ajustement par ancienneté se fait EN LECTURE, au moment de construire le contexte IA
// (cf. Lot D), jamais en réécrivant cette valeur par un job périodique.
@Injectable()
export class BrandLearningService {
  private readonly logger = new Logger(BrandLearningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly contradictions: ContradictionService,
  ) {}

  computeConfidence(signals: ConfidenceSignals): number {
    const evidenceFactor = Math.min(1, signals.evidenceCount / EVIDENCE_SATURATION);

    const totalPolaritySignals = signals.positiveSignals + signals.negativeSignals;
    // Neutre (0.5) quand aucun signal de polarité n'est suivi (ex: une observation d'édition
    // humaine n'est ni "positive" ni "négative" en soi, juste un fait constaté).
    const consistencyFactor = totalPolaritySignals > 0 ? signals.positiveSignals / totalPolaritySignals : 0.5;

    // La cohérence ne pèse que proportionnellement au volume d'évidence déjà accumulé — un
    // unique point 100% positif ne doit PAS produire une confiance élevée juste parce que son
    // taux de succès local est de 1/1 (cf. exemple Phase 3).
    const evidenceWeightedScore = evidenceFactor * (0.6 * consistencyFactor + 0.3);

    const sampleFactor =
      signals.sampleSize && signals.sampleSize > signals.evidenceCount
        ? Math.min(1, Math.log10(signals.sampleSize + 1) / Math.log10(1000))
        : 0;

    const raw = CONFIDENCE_FLOOR + evidenceWeightedScore + 0.1 * sampleFactor;
    return Math.max(0, Math.min(1, Math.round(raw * 1000) / 1000));
  }

  // Enregistre une observation — crée une nouvelle entrée si aucune correspondance exacte
  // (organisation + dedupKey) n'existe encore, ou renforce l'entrée existante sinon. Jamais
  // de promotion automatique vers RULE/PREFERENCE ici : ça reste une action humaine explicite
  // (cf. Phase 11, endpoint promote-to-rule en Lot E) ou une évolution ultérieure du type
  // décidée par un lot dédié — ce service ne fait qu'observer et calculer la confiance.
  async recordObservation(params: RecordObservationParams) {
    const existing = await this.prisma.brandMemoryEntry.findFirst({
      where: { organizationId: params.organizationId, dedupKey: params.dedupKey },
    });

    const positiveDelta = params.signal === 'positive' ? 1 : 0;
    const negativeDelta = params.signal === 'negative' ? 1 : 0;

    let result;
    if (!existing) {
      const evidenceCount = 1;
      const positiveSignals = positiveDelta;
      const negativeSignals = negativeDelta;
      const confidenceScore = this.computeConfidence({ evidenceCount, positiveSignals, negativeSignals, sampleSize: params.sampleSize });

      result = await this.prisma.brandMemoryEntry.create({
        data: {
          organizationId: params.organizationId,
          type: params.type ?? 'LEARNING',
          category: params.category,
          scope: params.scope ?? 'GLOBAL',
          channel: params.channel,
          persona: params.persona,
          contentType: params.contentType,
          content: params.content,
          confidenceScore,
          evidenceCount,
          positiveSignals,
          negativeSignals,
          sampleSize: params.sampleSize,
          source: params.source,
          sourceId: params.sourceId,
          sourceCampaignId: params.sourceCampaignId,
          dedupKey: params.dedupKey,
        },
      });
    } else {
      const evidenceCount = existing.evidenceCount + 1;
      const positiveSignals = existing.positiveSignals + positiveDelta;
      const negativeSignals = existing.negativeSignals + negativeDelta;
      const sampleSize = params.sampleSize ? (existing.sampleSize ?? 0) + params.sampleSize : existing.sampleSize;
      const confidenceScore = this.computeConfidence({ evidenceCount, positiveSignals, negativeSignals, sampleSize });

      result = await this.prisma.brandMemoryEntry.update({
        where: { id: existing.id },
        data: {
          content: params.content, // reflète la formulation la plus récente de l'observation
          evidenceCount,
          positiveSignals,
          negativeSignals,
          sampleSize,
          confidenceScore,
          lastObservedAt: new Date(),
        },
      });
    }

    // Phase 9 — best-effort : ne jamais faire échouer l'enregistrement d'une observation à
    // cause d'un bug dans la détection de contradictions, qui reste un enrichissement, pas le
    // cœur de l'écriture. Seulement si une catégorie est identifiable (cf. Phase 9 : comparer
    // des connaissances sur le même sujet, jamais au hasard).
    if (result.category) {
      try {
        await this.contradictions.scanForContradictions(params.organizationId, result.id, result.category);
      } catch (error) {
        this.logger.warn(`Scan de contradictions échoué pour l'entrée ${result.id}, observation conservée : ${error}`);
      }
    }

    return result;
  }

  // Isolation multi-tenant (Phase 17, CRITIQUE) : toute mutation ci-dessous passe par cette
  // vérification — une organisation ne peut jamais agir sur la connaissance d'une autre,
  // même en devinant un id valide.
  private async findOwnedEntry(organizationId: string, entryId: string) {
    const entry = await this.prisma.brandMemoryEntry.findFirst({ where: { id: entryId, organizationId } });
    if (!entry) throw new NotFoundException('Connaissance introuvable');
    return entry;
  }

  // Phase 13 ("confirmer") — un humain valide une observation : signal positif fort,
  // recalculé par le même moteur de confiance que les observations automatiques, jamais une
  // confiance arbitrairement fixée à 1.
  async confirmEntry(organizationId: string, entryId: string) {
    const entry = await this.findOwnedEntry(organizationId, entryId);
    const evidenceCount = entry.evidenceCount + 1;
    const positiveSignals = entry.positiveSignals + 1;
    const confidenceScore = this.computeConfidence({ evidenceCount, positiveSignals, negativeSignals: entry.negativeSignals, sampleSize: entry.sampleSize });

    return this.prisma.brandMemoryEntry.update({
      where: { id: entryId },
      data: { evidenceCount, positiveSignals, confidenceScore, lastObservedAt: new Date() },
    });
  }

  // Phase 13 ("rejeter" / "désactiver") — les deux actions ont le même effet réel (la
  // connaissance cesse d'être utilisée) : un seul endpoint plutôt que deux qui feraient
  // doublon. Jamais de suppression — DISMISSED reste consultable pour l'historique.
  async dismissEntry(organizationId: string, entryId: string) {
    await this.findOwnedEntry(organizationId, entryId);
    return this.prisma.brandMemoryEntry.update({ where: { id: entryId }, data: { status: 'DISMISSED' } });
  }

  // Phase 11/13 ("transformer un learning en règle") — action humaine explicite uniquement,
  // jamais automatique (cf. commentaire de recordObservation). forbiddenTerms, quand fourni,
  // rend la règle vérifiable par BrandRuleGuardService, pas seulement par le prompt.
  async promoteToRule(organizationId: string, entryId: string, forbiddenTerms?: string[]) {
    const entry = await this.findOwnedEntry(organizationId, entryId);
    const metadata = {
      ...((entry.metadata as Record<string, unknown> | null) ?? {}),
      ...(forbiddenTerms?.length ? { forbiddenTerms } : {}),
    };
    return this.prisma.brandMemoryEntry.update({ where: { id: entryId }, data: { type: 'RULE', metadata } });
  }

  // Phase 13 ("corriger") — un humain peut reformuler ou reclasser une connaissance
  // mal formulée par l'observation automatique ; seuls les champs fournis sont modifiés.
  async correctEntry(organizationId: string, entryId: string, params: CorrectEntryParams) {
    await this.findOwnedEntry(organizationId, entryId);
    const updated = await this.prisma.brandMemoryEntry.update({ where: { id: entryId }, data: { ...params } });

    // Correction de l'audit : recordObservation() relance déjà systématiquement le scan de
    // contradictions après écriture, mais correctEntry() (correction humaine manuelle,
    // Phase 13) ne le faisait jamais — une correction pouvait rendre une entrée ACTIVE
    // contradictoire avec une autre sans que personne ne le détecte, les deux restant
    // éligibles à être injectées ensemble dans le même prompt (cf. BrandMemoryQueryService).
    // Best-effort, même principe que recordObservation : un bug de détection ne doit jamais
    // faire échouer la correction elle-même.
    if (updated.category) {
      try {
        await this.contradictions.scanForContradictions(organizationId, updated.id, updated.category);
      } catch (error) {
        this.logger.warn(`Scan de contradictions échoué pour l'entrée corrigée ${updated.id}, correction conservée : ${error}`);
      }
    }

    return updated;
  }
}
