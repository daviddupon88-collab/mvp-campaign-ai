import { FactVerificationService } from './fact-verification.service';
import { Claim, FactVerificationStatus, SourceType } from './web-research.types';

function buildClaim(overrides: Partial<Claim> = {}): Claim {
  return { claim: '12 heures d\'autonomie', source: 'https://example.com', sourceType: SourceType.OFFICIAL, confidence: 0.9, verified: false, retrievedAt: new Date(), ...overrides };
}

// P1.5 — Fact Verification. Couvre exactement les cas du brief : classement par priorité de
// source, contradiction détectée, aucune source -> UNKNOWN, et le garde-fou spécifique MOCK
// (jamais VERIFIED, même en position de meilleure source).
describe('FactVerificationService.verifyClaim', () => {
  it('aucune source -> UNKNOWN, resolvedClaim null', () => {
    const service = new FactVerificationService();

    const result = service.verifyClaim([]);

    expect(result.status).toBe(FactVerificationStatus.UNKNOWN);
    expect(result.resolvedClaim).toBeNull();
  });

  it('une seule source OFFICIAL, aucun désaccord -> VERIFIED', () => {
    const service = new FactVerificationService();
    const claim = buildClaim({ sourceType: SourceType.OFFICIAL });

    const result = service.verifyClaim([claim]);

    expect(result.status).toBe(FactVerificationStatus.VERIFIED);
    expect(result.resolvedClaim).toBe(claim);
  });

  it('plusieurs sources d\'accord (même valeur) -> retient la source la mieux classée (OFFICIAL avant RETAILER)', () => {
    const service = new FactVerificationService();
    const official = buildClaim({ sourceType: SourceType.OFFICIAL, source: 'fabricant' });
    const retailer = buildClaim({ sourceType: SourceType.RETAILER, source: 'boutique' });

    const result = service.verifyClaim([retailer, official]); // ordre d'entrée inversé, ne doit pas influencer le résultat

    expect(result.status).toBe(FactVerificationStatus.VERIFIED);
    expect(result.resolvedClaim?.source).toBe('fabricant');
  });

  it('deux sources en désaccord sur la valeur -> CONTRADICTED, les deux versions conservées dans contradictions', () => {
    const service = new FactVerificationService();
    const official = buildClaim({ claim: '12 heures d\'autonomie', sourceType: SourceType.OFFICIAL });
    const review = buildClaim({ claim: '8 heures d\'autonomie', sourceType: SourceType.REVIEW });

    const result = service.verifyClaim([official, review]);

    expect(result.status).toBe(FactVerificationStatus.CONTRADICTED);
    expect(result.resolvedClaim?.sourceType).toBe(SourceType.OFFICIAL); // meilleure source retenue malgré le désaccord
    expect(result.contradictions).toHaveLength(1);
    expect(result.contradictions[0].claim).toBe('8 heures d\'autonomie');
  });

  it('source unique MARKETPLACE -> PROBABLE, pas VERIFIED (hiérarchie de confiance respectée)', () => {
    const service = new FactVerificationService();

    const result = service.verifyClaim([buildClaim({ sourceType: SourceType.MARKETPLACE })]);

    expect(result.status).toBe(FactVerificationStatus.PROBABLE);
  });

  it('source unique SOCIAL -> UNVERIFIED', () => {
    const service = new FactVerificationService();

    const result = service.verifyClaim([buildClaim({ sourceType: SourceType.SOCIAL })]);

    expect(result.status).toBe(FactVerificationStatus.UNVERIFIED);
  });

  it("source MOCK, même seule et sans désaccord -> UNVERIFIED, JAMAIS VERIFIED (garde-fou anti-faux-succès, défense en profondeur)", () => {
    const service = new FactVerificationService();

    const result = service.verifyClaim([buildClaim({ sourceType: SourceType.MOCK })]);

    expect(result.status).toBe(FactVerificationStatus.UNVERIFIED);
    expect(result.status).not.toBe(FactVerificationStatus.VERIFIED);
  });

  it('normalisation insensible à la casse/espaces : "12 heures" et "12 HEURES  " sont traitées comme la même valeur, pas une contradiction', () => {
    const service = new FactVerificationService();
    const a = buildClaim({ claim: '12 heures', sourceType: SourceType.OFFICIAL });
    const b = buildClaim({ claim: '12 HEURES  ', sourceType: SourceType.RETAILER });

    const result = service.verifyClaim([a, b]);

    expect(result.status).not.toBe(FactVerificationStatus.CONTRADICTED);
  });
});
