import { BadRequestException } from '@nestjs/common';
import { isBlockedAddress, resolveHostAddresses } from '../common/security/private-network-guard';

// Protection SSRF : `storeUrl` est une valeur fournie par le client (Shopify/WooCommerce/
// Prestashop), jamais un catalogue fixe — sans ce garde-fou, n'importe quel membre ADMIN/OWNER
// d'un tenant pourrait pointer une boutique vers une adresse interne (service interne, endpoint
// de métadonnées cloud, boucle locale) et faire agir le backend comme proxy pour sonder le
// réseau. Revérifié à CHAQUE appel sortant (connexion ET chaque synchronisation, cf.
// ProductImportService), pas seulement une fois à la connexion : une résolution DNS peut
// changer entre deux appels (DNS rebinding) — fenêtre résiduelle étroite mais non nulle entre
// cette vérification et l'appel HTTP réel ; un pinning IP complet (connecter directement à
// l'adresse validée, Host renseigné à part) serait la protection exhaustive si ce risque
// devient critique en production.
//
// Mission 4.4 (Product URL Intelligence) — le noyau de blocage d'adresses (plages IPv4/IPv6,
// résolution DNS) est désormais partagé via common/security/private-network-guard.ts (second
// appelant : ProductPageUrlValidator) — comportement et messages inchangés ici, refactor pur.

// Lève une BadRequestException si l'URL n'est pas joignable en toute sécurité depuis le
// backend — jamais un booléen silencieux, pour que l'appelant ne puisse pas oublier de
// vérifier le retour.
export async function assertPublicStoreUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestException('URL de boutique invalide');
  }

  if (parsed.protocol !== 'https:') {
    throw new BadRequestException('URL de boutique invalide : seul https:// est autorisé');
  }

  const addresses = await resolveHostAddresses(parsed.hostname, () => {
    throw new BadRequestException('Boutique introuvable — vérifiez le nom de domaine');
  });

  for (const { address, family } of addresses) {
    if (isBlockedAddress(address, family)) {
      throw new BadRequestException("Cette adresse de boutique n'est pas autorisée");
    }
  }
}
