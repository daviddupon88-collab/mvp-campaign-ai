// Valide qu'un contenu Google Ads édité MANUELLEMENT respecte encore les limites réelles de
// la plateforme (30 caractères/titre, 90/description) — la génération IA les applique déjà
// (troncature automatique, cf. AiOrchestratorService.parseGoogleAdsContent), mais rien ne
// protégeait jusqu'ici une édition manuelle via POST .../content/:id/edit.
//
// ContentVersion.body reste un simple champ texte pour ce canal (pas de structure JSON
// dédiée), au format exact produit par parseGoogleAdsContent() :
//   "Titres (30 caractères max) :\n1. ...\n2. ...\n\nDescriptions (90 caractères max) :\n1. ..."
// Ce parseur reproduit ce format pour retrouver quelles lignes sont des titres et
// lesquelles sont des descriptions. Si un utilisateur réécrit le texte dans un format
// totalement différent, il n'y a plus moyen de savoir quelle ligne est quoi — dans ce cas,
// aucune validation n'est possible ni appliquée (pas de faux positif sur du texte libre).

import { BadRequestException } from '@nestjs/common';

const HEADLINE_LIMIT = 30;
const DESCRIPTION_LIMIT = 90;

function extractNumberedLines(block: string | undefined): string[] {
  if (!block) return [];
  return block
    .split('\n')
    .map((line) => line.match(/^\s*\d+\.\s*(.*)$/)?.[1])
    .filter((text): text is string => text !== undefined);
}

export function validateGoogleAdsBody(body: string): void {
  const headlinesMatch = body.match(/Titres[^:]*:\n([\s\S]*?)(?:\n\n|$)/);
  const descriptionsMatch = body.match(/Descriptions[^:]*:\n([\s\S]*?)(?:\n\n|$)/);

  const headlines = extractNumberedLines(headlinesMatch?.[1]);
  const descriptions = extractNumberedLines(descriptionsMatch?.[1]);

  // Format non reconnu (texte réécrit librement) — rien à valider, on ne bloque jamais un
  // format qu'on ne comprend plus.
  if (headlines.length === 0 && descriptions.length === 0) return;

  const violations: string[] = [];
  headlines.forEach((h, i) => {
    if (h.length > HEADLINE_LIMIT) violations.push(`Titre ${i + 1} : ${h.length}/${HEADLINE_LIMIT} caractères`);
  });
  descriptions.forEach((d, i) => {
    if (d.length > DESCRIPTION_LIMIT) violations.push(`Description ${i + 1} : ${d.length}/${DESCRIPTION_LIMIT} caractères`);
  });

  if (violations.length > 0) {
    throw new BadRequestException(
      `Limites Google Ads dépassées — ${violations.join(', ')}. Un titre ne peut pas dépasser ${HEADLINE_LIMIT} caractères, une description ${DESCRIPTION_LIMIT}.`,
    );
  }
}
