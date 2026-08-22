import { lookup } from 'dns/promises';
import { isIP } from 'net';

// Mission 4.4 (Product URL Intelligence) — noyau SSRF partagé, extrait de
// product-import/store-url-guard.ts (seul garde-fou SSRF réel du backend avant ce chantier) pour
// être réutilisé tel quel par tout second appelant (ex. ProductPageUrlValidator) sans dupliquer
// la logique de blocage d'adresses privées. Fonctions PURES, aucune dépendance NestJS — testables
// indépendamment de tout contexte HTTP. store-url-guard.ts délègue désormais ici ; son
// comportement/ses messages restent inchangés (refactor pur, zéro changement de comportement).
export const BLOCKED_IPV4_RANGES: Array<[string, number]> = [
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

export function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

export function isBlockedIpv4(ip: string): boolean {
  const target = ipv4ToInt(ip);
  return BLOCKED_IPV4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (target & mask) === (ipv4ToInt(base) & mask);
  });
}

export function isBlockedIpv6(ip: string): boolean {
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

export function isBlockedAddress(address: string, family: 4 | 6): boolean {
  return family === 4 ? isBlockedIpv4(address) : isBlockedIpv6(address);
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

// Résout un hostname en adresses IP (ou retourne directement l'IP littérale si `hostname` en est
// déjà une) — revérifié à CHAQUE appel sortant par les deux appelants (jamais mis en cache), pour
// limiter la fenêtre de DNS rebinding. `onLookupFailure` personnalise le message d'erreur par
// appelant (ex. "boutique introuvable" vs "page produit introuvable").
export async function resolveHostAddresses(hostname: string, onLookupFailure: () => never): Promise<ResolvedAddress[]> {
  const literalIpVersion = isIP(hostname);
  if (literalIpVersion) {
    return [{ address: hostname, family: literalIpVersion as 4 | 6 }];
  }
  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.map((a) => ({ address: a.address, family: a.family as 4 | 6 }));
  } catch {
    onLookupFailure();
  }
}
