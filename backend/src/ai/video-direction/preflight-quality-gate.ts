import { VisualDna } from './visual-dna.service';
import { ShotPlan } from './video-director.service';
import { ShotPlanValidationResult } from './shot-plan-validator';
import { CreativeConcept } from '../creative-intelligence/creative-concept.types';
import { NarrativeBlueprint } from '../creative-intelligence/narrative-blueprint.types';
import { ProductFactConflict } from '../product-intelligence/product-fact.types';

// Mission 4.4 (Product URL Intelligence, Phase Q) — attributs d'IDENTITÉ produit dont une
// contradiction NON RÉSOLUE bloque la génération : une divergence sur la marque/le nom du
// produit signifie que le concept risque de raconter/montrer le MAUVAIS produit. Volontairement
// restreint à ces 2 attributs (pas toute spécification) — une divergence sur un attribut
// secondaire (ex. couleur exacte) est un signal de qualité, pas un motif de blocage automatique
// avant même toute génération vidéo.
// Exporté (Mission 4.5, Phase 1 — instrumentation) : PipelineMetricsService.getProductGroundingMetrics
// réutilise EXACTEMENT cette définition pour compter les conflits "critiques" plutôt que d'en
// dupliquer une copie qui pourrait diverger silencieusement de la vraie logique de blocage.
export const CRITICAL_IDENTITY_ATTRIBUTES = new Set(['brand', 'name']);

// Mission 4.3 — Goal-First Quality Architecture, Phase 5, Étape 7. Fonction PURE, coût zéro
// (aucun appel IA — même discipline que shot-plan-validator.ts), placée juste avant la boucle de
// génération vidéo (150 crédits/plan). Plusieurs champs introduits par les Phases 1-4 sont
// CALCULÉS et DEMANDÉS depuis longtemps mais n'étaient encore vérifiés par RIEN avant ce chantier
// — qualityAlignment (Phase 2), NarrativeBlueprint.beats (Phase 3), le risque de lien orphelin
// introduit par Shot.narrativeBeatId (Phase 4). Ce gate est le premier point qui les fait
// réellement compter.
//
// Ne duplique jamais shot-plan-validator.ts (nombre de plans, validité structurelle, présence
// d'un texte, bornes de durée) — shotPlanValidation est repris tel quel, jamais recalculé.
export interface PreFlightQualityInput {
  visualDna: VisualDna;
  creativeConcept: CreativeConcept;
  narrativeBlueprint: NarrativeBlueprint;
  shotPlan: ShotPlan;
  shotPlanValidation: ShotPlanValidationResult;
  narrationText: string;
  // Mission 4.4 (Product URL Intelligence, Phase Q) — optionnel : absent quand aucune URL
  // produit n'a été fournie/exploitée. Une URL inaccessible (facts null) n'est JAMAIS elle-même
  // bloquante (brief : "une URL inaccessible ne doit pas automatiquement bloquer une campagne
  // si la photo + description permettent une campagne valide") — seul un conflit d'IDENTITÉ non
  // résolu bloque ici.
  productConflicts?: ProductFactConflict[];
}

export interface PreFlightQualityResult {
  ready: boolean;
  blockingReasons: string[];
}

export function evaluatePreFlightQuality(input: PreFlightQualityInput): PreFlightQualityResult {
  const blockingReasons: string[] = [];

  // PRODUCT
  if (input.visualDna.isFallback) {
    blockingReasons.push('Visual DNA indisponible ou en repli neutre (isFallback=true) — fidélité visuelle du produit non garantie.');
  } else if (input.visualDna.distinctiveFeatures.length === 0) {
    blockingReasons.push("Visual DNA sans élément distinctif identifié — fidélité produit non vérifiable.");
  }

  // CONCEPT
  if (!input.creativeConcept.hook.trim()) {
    blockingReasons.push('Hook absent ou générique dans le concept créatif.');
  }
  if (!input.creativeConcept.cta.trim()) {
    blockingReasons.push('Aucun CTA défini dans le concept créatif.');
  }
  if (!input.creativeConcept.qualityAlignment.trim()) {
    blockingReasons.push("Aucune preuve d'alignement qualité (qualityAlignment vide) — le concept n'a jamais démontré satisfaire le QualityTarget.");
  }

  // NARRATIVE
  if (input.narrativeBlueprint.beats.length === 0) {
    blockingReasons.push('Aucun beat narratif défini dans le NarrativeBlueprint.');
  } else {
    const beatsWithoutEvidence = input.narrativeBlueprint.beats.filter((b) => !b.requiredVisualEvidence.trim());
    if (beatsWithoutEvidence.length > 0) {
      blockingReasons.push(
        `${beatsWithoutEvidence.length} beat(s) narratif(s) sans preuve visuelle attendue (requiredVisualEvidence vide) : ${beatsWithoutEvidence.map((b) => b.id).join(', ')}.`,
      );
    }
  }

  // SHOT PLAN — source unique : shotPlanValidation.reasons repris tels quels, jamais recalculés.
  if (!input.shotPlanValidation.passed) {
    blockingReasons.push(...input.shotPlanValidation.reasons);
  }
  const fallbackShots = input.shotPlan.filter((s) => s.usedFallbackTemplate);
  if (fallbackShots.length > 0) {
    blockingReasons.push(
      `${fallbackShots.length} plan(s) sont un gabarit générique de repli (usedFallbackTemplate) : ${fallbackShots.map((s) => s.sceneId).join(', ')} — décision explicite requise, jamais une substitution silencieuse.`,
    );
  }

  // EXECUTION — lien orphelin (risque introduit par Shot.narrativeBeatId, Phase 4).
  const beatIds = new Set(input.narrativeBlueprint.beats.map((b) => b.id));
  const orphanedLinks = input.shotPlan.filter((s) => s.narrativeBeatId && !beatIds.has(s.narrativeBeatId));
  if (orphanedLinks.length > 0) {
    blockingReasons.push(
      `${orphanedLinks.length} plan(s) référencent un narrativeBeatId inconnu du NarrativeBlueprint : ${orphanedLinks.map((s) => s.sceneId).join(', ')}.`,
    );
  }

  // DELIVERY
  if (!input.narrationText.trim()) {
    blockingReasons.push('Aucune narration disponible.');
  }

  // PRODUCT_SOURCE (Mission 4.4, Product URL Intelligence) — distinct du bloc PRODUCT ci-dessus
  // (Visual DNA) : ici, une contradiction ENTRE SOURCES sur l'identité du produit (photo vs page
  // produit), jamais l'absence de l'URL elle-même (cf. commentaire sur productConflicts?).
  const criticalUnresolvedConflicts = (input.productConflicts ?? []).filter(
    (c) => c.resolution === 'UNRESOLVED' && CRITICAL_IDENTITY_ATTRIBUTES.has(c.attribute),
  );
  if (criticalUnresolvedConflicts.length > 0) {
    blockingReasons.push(
      ...criticalUnresolvedConflicts.map(
        (c) => `Conflit d'identité produit non résolu (${c.attribute}) : ${c.sources.map((s) => `${s.source}="${s.value}"`).join(' vs ')} — ${c.reason}`,
      ),
    );
  }

  return { ready: blockingReasons.length === 0, blockingReasons };
}
