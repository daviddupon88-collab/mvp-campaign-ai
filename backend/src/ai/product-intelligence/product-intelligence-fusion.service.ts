import { Injectable } from '@nestjs/common';
import { ProductVisionAnalysis } from './product-intelligence.types';
import { ProductUrlFacts } from './product-page/product-url-facts.types';
import { ProductFact, ProductClaim, ProductFactConflict, ProductFactSource } from './product-fact.types';

export interface ProductIntelligenceFusionResult {
  facts: ProductFact[];
  claims: ProductClaim[];
  conflicts: ProductFactConflict[];
}

interface Candidate {
  source: ProductFactSource;
  value: string;
  confidence: number;
}

// Mission 4.4 (Product URL Intelligence, Phase I) — cœur de la mission : Image Intelligence + URL
// Intelligence + User Description -> Canonical Product Intelligence Profile. Chaque attribut est
// résolu avec valeur/source/confiance/conflit éventuel/décision de résolution (brief, Phase I) —
// jamais un simple écrasement silencieux d'une source par une autre.
//
// N'utilise PAS FactVerificationService.verifyClaim() ici : cet axe compare des SOURCES DE
// CONFIANCE WEB (SourceType : OFFICIAL/RETAILER/REVIEW...) pour un ENSEMBLE de résultats de
// recherche sur UNE même question — l'axe de cette fusion est différent (MODALITÉ d'entrée :
// IMAGE/PRODUCT_URL/USER, au plus 2-3 candidats par attribut, jamais un ensemble de résultats web)
// — le forcer dans cette forme exigerait un mapping sémantiquement incorrect. Politique de
// résolution dédiée, déterministe, documentée ci-dessous plutôt que masquée.
const OBJECTIVE_SPEC_PRIORITY: ProductFactSource[] = ['PRODUCT_URL', 'IMAGE', 'USER', 'INFERENCE'];
// Écart de confiance en-dessous duquel deux candidats sont considérés "à égalité" — dans ce cas,
// même si une priorité de politique existe, on préfère être honnête (UNRESOLVED) plutôt que de
// trancher arbitrairement sur un écart négligeable.
const TIE_CONFIDENCE_MARGIN = 0.1;

@Injectable()
export class ProductIntelligenceFusionService {
  fuse(vision: ProductVisionAnalysis, urlFacts: ProductUrlFacts | null, userDescription: string | undefined): ProductIntelligenceFusionResult {
    const facts: ProductFact[] = [];
    const conflicts: ProductFactConflict[] = [];

    this.resolveAttribute('brand', OBJECTIVE_SPEC_PRIORITY, [
      vision.brand ? { source: 'IMAGE', value: vision.brand, confidence: vision.confidence } : null,
      urlFacts?.brand ? { source: 'PRODUCT_URL', value: urlFacts.brand, confidence: 0.9 } : null,
    ], facts, conflicts);

    this.resolveAttribute('name', OBJECTIVE_SPEC_PRIORITY, [
      vision.productName ? { source: 'IMAGE', value: vision.productName, confidence: vision.confidence } : null,
      urlFacts?.title ? { source: 'PRODUCT_URL', value: urlFacts.title, confidence: 0.9 } : null,
    ], facts, conflicts);

    this.resolveAttribute('category', OBJECTIVE_SPEC_PRIORITY, [
      vision.category ? { source: 'IMAGE', value: vision.category, confidence: vision.confidence } : null,
      urlFacts?.category ? { source: 'PRODUCT_URL', value: urlFacts.category, confidence: 0.85 } : null,
    ], facts, conflicts);

    // Attributs purement visuels — l'IMAGE est la source de vérité (politique : IMAGE > PRODUCT_URL
    // pour ce qui est RÉELLEMENT visible sur la photo — une description marketing de la page
    // produit peut décrire une variante différente de celle photographiée). Aucune contrepartie
    // URL structurée comparable pour matière/couleur, donc jamais de conflit possible ici.
    for (const material of vision.materials) {
      facts.push({ key: 'material', value: material, source: 'IMAGE', confidence: vision.confidence });
    }
    for (const color of vision.colors) {
      facts.push({ key: 'color', value: color, source: 'IMAGE', confidence: vision.confidence });
    }

    // Spécifications structurées provenant UNIQUEMENT de l'URL (prix, dimensions, SKU...) —
    // aucune contrepartie image/vision comparable, donc jamais de conflit possible ici.
    for (const spec of urlFacts?.specifications ?? []) {
      facts.push({ key: spec.key, value: spec.unit ? `${spec.value} ${spec.unit}` : spec.value, source: 'PRODUCT_URL', confidence: 0.9, evidence: 'JSON-LD/OpenGraph/HTML de la page produit' });
    }

    // Description utilisateur : source de dernier recours, jamais comparée pour un conflit
    // (texte libre non structuré, aucune base fiable pour détecter une contradiction précise).
    if (userDescription?.trim()) {
      facts.push({ key: 'user_description', value: userDescription.trim(), source: 'USER', confidence: 0.5 });
    }

    const claims: ProductClaim[] = urlFacts?.claims ?? [];

    return { facts, claims, conflicts };
  }

  private resolveAttribute(
    attribute: string,
    priority: ProductFactSource[],
    rawCandidates: (Candidate | null)[],
    facts: ProductFact[],
    conflicts: ProductFactConflict[],
  ): void {
    const candidates = rawCandidates.filter((c): c is Candidate => c !== null);
    if (candidates.length === 0) return;
    if (candidates.length === 1) {
      facts.push({ key: attribute, value: candidates[0].value, source: candidates[0].source, confidence: candidates[0].confidence });
      return;
    }

    const distinctValues = new Set(candidates.map((c) => this.normalize(c.value)));
    if (distinctValues.size === 1) {
      // Accord entre sources — retient la plus prioritaire, confiance renforcée par l'accord.
      const best = this.pickByPriority(candidates, priority);
      facts.push({ key: attribute, value: best.value, source: best.source, confidence: Math.min(1, best.confidence + 0.05) });
      return;
    }

    // Désaccord réel — jamais un écrasement silencieux (brief, Phase J : "Ne pas simplement
    // supprimer la vision").
    const sorted = [...candidates].sort((a, b) => priority.indexOf(a.source) - priority.indexOf(b.source));
    const best = sorted[0];
    const second = sorted[1];
    const confidenceGapTooSmall = Math.abs(best.confidence - second.confidence) < TIE_CONFIDENCE_MARGIN;

    const resolution = confidenceGapTooSmall
      ? 'UNRESOLVED'
      : best.source === 'PRODUCT_URL'
        ? 'URL_PREFERRED'
        : best.source === 'IMAGE'
          ? 'IMAGE_PREFERRED'
          : best.source === 'USER'
            ? 'USER_PREFERRED'
            : 'UNRESOLVED';

    conflicts.push({
      attribute,
      sources: candidates.map((c) => ({ source: c.source, value: c.value, confidence: c.confidence })),
      resolution,
      reason: confidenceGapTooSmall
        ? `Sources en désaccord (${candidates.map((c) => `${c.source}="${c.value}"`).join(' vs ')}) avec des niveaux de confiance trop proches pour trancher automatiquement.`
        : `Sources en désaccord — "${best.source}" retenu par politique de priorité (${priority.join(' > ')}).`,
    });

    if (resolution !== 'UNRESOLVED') {
      facts.push({ key: attribute, value: best.value, source: best.source, confidence: best.confidence, evidence: `Conflit résolu par priorité de source (${resolution}).` });
    }
  }

  private pickByPriority(candidates: Candidate[], priority: ProductFactSource[]): Candidate {
    return [...candidates].sort((a, b) => priority.indexOf(a.source) - priority.indexOf(b.source))[0];
  }

  private normalize(value: string): string {
    return value.trim().toLowerCase();
  }
}
