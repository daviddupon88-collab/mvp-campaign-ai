import { Injectable } from '@nestjs/common';
import { Claim, FactVerificationStatus, SourceType, SOURCE_TYPE_PRIORITY } from './web-research.types';

export interface FactVerificationResult {
  status: FactVerificationStatus;
  resolvedClaim: Claim | null;
  contradictions: Claim[];
}

// P1.5 — Fact Verification (chantier "Product Intelligence & Creative Intelligence Engine V2",
// 2026-08-18). Logique DÉTERMINISTE (pas d'appel IA) : classement par priorité de source,
// détection de contradiction entre sources, attribution d'un statut. Fonctionne IDENTIQUEMENT
// avec des Claim[] issus de MockWebResearchProvider aujourd'hui ou d'un vrai fournisseur demain
// — aucun changement de code requis au branchement d'un vrai fournisseur. Le contrat d'entrée :
// tous les Claim[] passés à verifyClaim() portent sur LA MÊME question factuelle (ex: "quelle est
// l'autonomie de la batterie ?"), collectés depuis différentes sources — regrouper par question
// est la responsabilité de l'appelant, pas de ce service.
@Injectable()
export class FactVerificationService {
  verifyClaim(claims: Claim[]): FactVerificationResult {
    if (claims.length === 0) {
      return { status: FactVerificationStatus.UNKNOWN, resolvedClaim: null, contradictions: [] };
    }

    const sorted = [...claims].sort((a, b) => this.priorityIndex(a.sourceType) - this.priorityIndex(b.sourceType));
    const best = sorted[0];
    const distinctValues = new Set(claims.map((c) => this.normalize(c.claim)));

    if (distinctValues.size > 1) {
      // Contradiction : au moins deux sources ne s'accordent pas sur la valeur du claim. On
      // retient la source la mieux classée comme "meilleure hypothèse" mais le statut reste
      // CONTRADICTED — la présence d'un désaccord est elle-même une information à ne jamais
      // masquer (cf. règle du brief "conserver les contradictions").
      const contradictions = claims.filter((c) => this.normalize(c.claim) !== this.normalize(best.claim));
      return { status: FactVerificationStatus.CONTRADICTED, resolvedClaim: best, contradictions };
    }

    return { status: this.statusForSourceType(best.sourceType), resolvedClaim: best, contradictions: [] };
  }

  private normalize(claim: string): string {
    return claim.trim().toLowerCase();
  }

  private priorityIndex(sourceType: SourceType): number {
    const index = SOURCE_TYPE_PRIORITY.indexOf(sourceType);
    return index === -1 ? SOURCE_TYPE_PRIORITY.length : index;
  }

  // Une source MOCK ne produit JAMAIS VERIFIED, quelle que soit sa position dans le classement —
  // défense en profondeur cohérente avec la règle absolue du brief ("un mock ne doit jamais être
  // présenté comme une recherche Web réelle"), appliquée ici aussi, pas seulement dans
  // WebResearchService.
  private statusForSourceType(sourceType: SourceType): FactVerificationStatus {
    if (sourceType === SourceType.MOCK) return FactVerificationStatus.UNVERIFIED;
    if (sourceType === SourceType.OFFICIAL || sourceType === SourceType.MANUFACTURER) return FactVerificationStatus.VERIFIED;
    if (sourceType === SourceType.AUTHORIZED_RETAILER || sourceType === SourceType.RETAILER || sourceType === SourceType.MARKETPLACE) return FactVerificationStatus.PROBABLE;
    return FactVerificationStatus.UNVERIFIED; // REVIEW, SOCIAL, OTHER
  }
}
