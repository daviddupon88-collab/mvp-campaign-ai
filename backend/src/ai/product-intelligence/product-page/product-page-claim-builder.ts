import { ProductClaim } from '../product-fact.types';
import { ProductSpecification } from './product-url-facts.types';

// Mission 4.4 (Product URL Intelligence, Phase G) — mappe des faits extraits déterministiquement
// (JSON-LD/OpenGraph/HTML) en ProductClaim[]. allowedForAdvertising est calculé ICI,
// déterministiquement — JAMAIS auto-déclaré par un LLM (brief : "une inférence LLM ne devient
// jamais automatiquement un fait produit"). Règle : une claim n'est publicitairement exploitable
// que si elle provient d'un champ STRUCTURÉ (spec/prix/dispo) — jamais un texte marketing libre
// scrappé de la page (superlatifs, bénéfices non vérifiables), même si présent sur la page
// officielle du fabricant. Exemple du brief : "Capacité de 750 ml" (autorisé, structuré) vs
// "Le meilleur produit du marché" (jamais autorisé, aucune preuve).
const CONFIDENCE_FLOOR = 0.6;

let claimCounter = 0;
function nextClaimId(): string {
  claimCounter += 1;
  return `product-url-claim-${claimCounter}`;
}

export interface ClaimBuilderInput {
  title?: string;
  brand?: string;
  specifications: ProductSpecification[];
  price?: { amount: number; currency: string };
  availability?: string;
}

export function buildProductPageClaims(input: ClaimBuilderInput): ProductClaim[] {
  const claims: ProductClaim[] = [];

  for (const spec of input.specifications) {
    const text = spec.unit ? `${spec.key} : ${spec.value} ${spec.unit}` : `${spec.key} : ${spec.value}`;
    claims.push({
      id: nextClaimId(),
      text,
      source: 'PRODUCT_URL',
      evidence: `JSON-LD Product / additionalProperty (${spec.key})`,
      confidence: 0.95,
      allowedForAdvertising: true,
    });
  }

  if (input.price) {
    claims.push({
      id: nextClaimId(),
      text: `Prix : ${input.price.amount} ${input.price.currency}`,
      source: 'PRODUCT_URL',
      evidence: 'JSON-LD Product / offers',
      confidence: 0.9,
      allowedForAdvertising: true,
    });
  }

  if (input.availability) {
    claims.push({
      id: nextClaimId(),
      text: `Disponibilité : ${input.availability}`,
      source: 'PRODUCT_URL',
      evidence: 'JSON-LD Product / offers.availability',
      confidence: 0.85,
      allowedForAdvertising: true,
    });
  }

  if (input.brand) {
    claims.push({
      id: nextClaimId(),
      text: `Marque : ${input.brand}`,
      source: 'PRODUCT_URL',
      evidence: 'JSON-LD Product / brand',
      confidence: CONFIDENCE_FLOOR + 0.3,
      allowedForAdvertising: true,
    });
  }

  return claims;
}
