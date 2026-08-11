import { BadRequestException } from '@nestjs/common';
import { validateGoogleAdsBody } from './google-ads-body-guard';

function buildBody(headlines: string[], descriptions: string[]): string {
  const headlinesText = headlines.map((h, i) => `${i + 1}. ${h}`).join('\n');
  const descriptionsText = descriptions.map((d, i) => `${i + 1}. ${d}`).join('\n');
  return `Titres (30 caractères max) :\n${headlinesText}\n\nDescriptions (90 caractères max) :\n${descriptionsText}`;
}

describe('validateGoogleAdsBody', () => {
  it('accepte un contenu dont tous les titres/descriptions respectent les limites', () => {
    const body = buildBody(['Chaussures légères', 'Amorti réactif'], ['Découvrez notre nouvelle gamme de running.']);
    expect(() => validateGoogleAdsBody(body)).not.toThrow();
  });

  it('rejette un titre dépassant 30 caractères', () => {
    const tropLong = 'Ce titre fait bien plus de trente caractères de long';
    const body = buildBody([tropLong], ['Description correcte.']);
    expect(() => validateGoogleAdsBody(body)).toThrow(BadRequestException);
  });

  it('rejette une description dépassant 90 caractères', () => {
    const tropLongue = 'A'.repeat(95);
    const body = buildBody(['Titre correct'], [tropLongue]);
    expect(() => validateGoogleAdsBody(body)).toThrow(BadRequestException);
  });

  it('le message d\'erreur identifie précisément quelle ligne dépasse et de combien', () => {
    const body = buildBody(['x'.repeat(35)], ['Description correcte.']);
    expect(() => validateGoogleAdsBody(body)).toThrow(/Titre 1 : 35\/30/);
  });

  it('ne bloque jamais un texte réécrit dans un format non reconnu (pas de faux positif)', () => {
    const freeform = 'Un texte totalement réécrit par l\'utilisateur, sans structure Titres/Descriptions.';
    expect(() => validateGoogleAdsBody(freeform)).not.toThrow();
  });

  it('valide indépendamment plusieurs titres et descriptions dans le même contenu', () => {
    const body = buildBody(
      ['Titre 1 ok', 'x'.repeat(31)],
      ['Description 1 ok', 'y'.repeat(91)],
    );
    expect(() => validateGoogleAdsBody(body)).toThrow(/Titre 2.*Description 2|Description 2.*Titre 2/);
  });
});
