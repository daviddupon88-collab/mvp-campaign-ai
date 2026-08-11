import { BadRequestException } from '@nestjs/common';
import { lookup } from 'dns/promises';
import { isIP } from 'net';

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
const BLOCKED_IPV4_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // boucle locale
  ['169.254.0.0', 16], // link-local — inclut 169.254.169.254, métadonnées cloud AWS/GCP/Azure
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4], // multicast et au-delà
];

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function isBlockedIpv4(ip: string): boolean {
  const target = ipv4ToInt(ip);
  return BLOCKED_IPV4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (target & mask) === (ipv4ToInt(base) & mask);
  });
}

function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    // Adresse IPv4-mappée en IPv6 (ex: ::ffff:127.0.0.1) — revalider la partie IPv4.
    const ipv4Part = normalized.split(':').pop()!;
    return isIP(ipv4Part) === 4 ? isBlockedIpv4(ipv4Part) : true;
  }
  return (
    normalized === '::1' || // boucle locale
    normalized.startsWith('fe80:') || // link-local
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') // unique local (fc00::/7)
  );
}

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

  const hostname = parsed.hostname;
  const literalIpVersion = isIP(hostname);

  const addresses = literalIpVersion
    ? [{ address: hostname, family: literalIpVersion as 4 | 6 }]
    : await lookup(hostname, { all: true, verbatim: true }).catch(() => {
        throw new BadRequestException('Boutique introuvable — vérifiez le nom de domaine');
      });

  for (const { address, family } of addresses) {
    const blocked = family === 4 ? isBlockedIpv4(address) : isBlockedIpv6(address);
    if (blocked) {
      throw new BadRequestException("Cette adresse de boutique n'est pas autorisée");
    }
  }
}
