import { ProductIntelligenceProfile } from '@prisma/client';

// P0.4 — Product Grounding (chantier "Product Intelligence & Creative Intelligence Engine V2",
// 2026-08-18). Fonction PURE (pas un service injectable — même convention que
// resolve-media-buffer.ts / brand/temporal-decay.util.ts) : traduit le Product Intelligence
// Profile en un bloc de contexte + règles strictes, injecté dans les prompts en aval. C'est ICI,
// et uniquement ici, que la règle de grounding devient un texte concret reçu par les modèles —
// pas une politique abstraite. Toute information absente du profil reste explicitement INCONNUE
// dans le texte produit, jamais silencieusement omise (ce qui laisserait le modèle deviner).
export function renderGroundedContext(profile: ProductIntelligenceProfile): string {
  const identity = [profile.category, profile.subcategory].filter(Boolean).join(' / ') || 'catégorie non déterminée';
  const brandLine = [profile.brand, profile.productName, profile.model].filter(Boolean).join(' ') || 'marque/modèle non identifiés avec certitude';

  const features = asStringArray(profile.features);
  const usps = asStringArray(profile.usps);
  const visibleClaims = asStringArray(profile.visibleClaims);

  const webResearchLine =
    profile.webResearchStatus === 'NOT_CONFIGURED'
      ? "Recherche web : NON DISPONIBLE — aucune vérification externe n'a été effectuée pour ce produit. Ne présente comme un fait vérifié AUCUNE information (prix, certification, garantie, avis client) qui ne figure pas explicitement ci-dessous."
      : `Recherche web : ${profile.webResearchStatus}.`;

  // Mission 4.4 (Product URL Intelligence, Phase I) — additif, propage automatiquement à TOUT
  // consommateur de renderGroundedContext (CreativeIntelligenceService, CreativeGateService,
  // StoryboardGateService, VideoJudgeService) sans toucher leurs propres signatures. Absent quand
  // aucune URL produit n'a été fournie/exploitée (profile.productClaims null) — jamais un bloc
  // vide silencieux, simplement omis.
  const verifiedClaims = asClaims(profile.productClaims).filter((c) => c.allowedForAdvertising);
  const verifiedClaimsBlock = verifiedClaims.length
    ? `\n\n=== FAITS PRODUIT VÉRIFIÉS (page produit) — utilisables tels quels dans la publicité ===\n${verifiedClaims.map((c) => `- ${c.text} (${c.evidence})`).join('\n')}`
    : '';

  const unresolvedConflicts = asConflicts(profile.productConflicts).filter((c) => c.resolution === 'UNRESOLVED');
  const conflictsBlock = unresolvedConflicts.length
    ? `\n\n=== CONTRADICTIONS NON RÉSOLUES — ne jamais affirmer une valeur pour ces attributs ===\n${unresolvedConflicts.map((c) => `- ${c.attribute} : ${c.sources.map((s) => `${s.source}="${s.value}"`).join(' vs ')} — ${c.reason}`).join('\n')}`
    : '';

  return `=== Intelligence produit (source de vérité pour cette génération) ===
Identité : ${identity} — ${brandLine}
Caractéristiques visuelles confirmées (analyse vision) : ${features.length ? features.join(', ') : 'aucune caractéristique distinctive confirmée'}
USP détectées : ${usps.length ? usps.join(', ') : 'aucune USP confirmée'}
Affirmations visibles sur le produit/packaging (transcrites, NON vérifiées indépendamment) : ${visibleClaims.length ? visibleClaims.join(', ') : 'aucune'}
${webResearchLine}${verifiedClaimsBlock}${conflictsBlock}

RÈGLES STRICTES DE GROUNDING : n'invente JAMAIS un prix, une certification, une garantie, un témoignage, ou une caractéristique absente de ce bloc. Toute information non listée ci-dessus doit être traitée comme INCONNUE, jamais comme un fait établi. Une affirmation "NON vérifiée" (ci-dessus) peut être mentionnée comme telle, mais ne doit jamais être présentée comme une certitude.${unresolvedConflicts.length ? ' Pour un attribut listé en CONTRADICTION NON RÉSOLUE, ne choisis JAMAIS arbitrairement une des valeurs en désaccord.' : ''}`;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asClaims(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asConflicts(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}
