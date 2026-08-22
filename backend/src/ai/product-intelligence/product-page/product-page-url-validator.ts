import { BadRequestException } from '@nestjs/common';
import { isBlockedAddress, resolveHostAddresses } from '../../../common/security/private-network-guard';

// Mission 4.4 (Product URL Intelligence, Phase A) — protection SSRF pour `productUrl`, une URL
// EXTERNE arbitraire fournie par l'utilisateur (contrairement à productImageAssetId, résolu côté
// serveur vers un Asset déjà téléversé, cf. campaigns.service.ts — jamais une URL externe
// arbitraire pour l'image). Réutilise le noyau de blocage d'adresses de
// common/security/private-network-guard.ts (même discipline que store-url-guard.ts, jamais
// dupliquée) — seule la politique de protocole diffère : une page produit publique est très
// souvent atteinte via une redirection http -> https initiale (contrairement à une intégration
// boutique OAuth, toujours https d'emblée), donc http: est autorisé ICI en entrée — mais
// SafeProductPageFetcher (Phase B) revalide CHAQUE cible de redirection avec cette même fonction,
// fermant ainsi le risque qu'une redirection pointe vers une adresse privée.
const MAX_URL_LENGTH = 2048;

export async function assertValidProductPageUrl(rawUrl: string): Promise<URL> {
  if (rawUrl.length > MAX_URL_LENGTH) {
    throw new BadRequestException(`URL de page produit trop longue (max ${MAX_URL_LENGTH} caractères)`);
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestException('URL de page produit invalide');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestException('URL de page produit invalide : seuls http:// et https:// sont autorisés');
  }

  const addresses = await resolveHostAddresses(parsed.hostname, () => {
    throw new BadRequestException('Page produit introuvable — vérifiez le nom de domaine');
  });

  for (const { address, family } of addresses) {
    if (isBlockedAddress(address, family)) {
      throw new BadRequestException("Cette adresse de page produit n'est pas autorisée");
    }
  }

  return parsed;
}
