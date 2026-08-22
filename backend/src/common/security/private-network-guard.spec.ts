import { isBlockedIpv4, isBlockedIpv6, isBlockedAddress, ipv4ToInt, resolveHostAddresses } from './private-network-guard';

describe('isBlockedIpv4', () => {
  it('bloque la boucle locale (127.0.0.0/8)', () => {
    expect(isBlockedIpv4('127.0.0.1')).toBe(true);
  });

  it('bloque 0.0.0.0', () => {
    expect(isBlockedIpv4('0.0.0.0')).toBe(true);
  });

  it('bloque les plages RFC 1918 (10/8, 172.16/12, 192.168/16)', () => {
    expect(isBlockedIpv4('10.0.0.5')).toBe(true);
    expect(isBlockedIpv4('172.16.0.1')).toBe(true);
    expect(isBlockedIpv4('172.31.255.255')).toBe(true);
    expect(isBlockedIpv4('192.168.1.1')).toBe(true);
  });

  it('bloque le link-local incluant le endpoint de métadonnées cloud (169.254.169.254)', () => {
    expect(isBlockedIpv4('169.254.169.254')).toBe(true);
    expect(isBlockedIpv4('169.254.0.1')).toBe(true);
  });

  it('bloque le CGNAT (100.64.0.0/10)', () => {
    expect(isBlockedIpv4('100.64.0.1')).toBe(true);
  });

  it("n'affecte pas une adresse publique réelle", () => {
    expect(isBlockedIpv4('93.184.216.34')).toBe(false); // example.com
    expect(isBlockedIpv4('8.8.8.8')).toBe(false);
  });
});

describe('isBlockedIpv6', () => {
  it('bloque la boucle locale ::1', () => {
    expect(isBlockedIpv6('::1')).toBe(true);
  });

  it('bloque le link-local fe80::/10', () => {
    expect(isBlockedIpv6('fe80::1')).toBe(true);
  });

  it('bloque unique-local fc00::/7 (fc/fd)', () => {
    expect(isBlockedIpv6('fc00::1')).toBe(true);
    expect(isBlockedIpv6('fd12:3456::1')).toBe(true);
  });

  it('revalide une adresse IPv4-mappée (::ffff:127.0.0.1) contre les plages IPv4', () => {
    expect(isBlockedIpv6('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedIpv6('::ffff:8.8.8.8')).toBe(false);
  });

  it("n'affecte pas une adresse IPv6 publique", () => {
    expect(isBlockedIpv6('2606:4700:4700::1111')).toBe(false); // Cloudflare DNS
  });
});

describe('isBlockedAddress', () => {
  it('délègue vers isBlockedIpv4/isBlockedIpv6 selon family', () => {
    expect(isBlockedAddress('127.0.0.1', 4)).toBe(true);
    expect(isBlockedAddress('::1', 6)).toBe(true);
    expect(isBlockedAddress('8.8.8.8', 4)).toBe(false);
  });
});

describe('ipv4ToInt', () => {
  it('convertit une IPv4 en entier 32 bits', () => {
    expect(ipv4ToInt('0.0.0.1')).toBe(1);
    expect(ipv4ToInt('255.255.255.255')).toBe(0xffffffff);
  });
});

describe('resolveHostAddresses', () => {
  it('retourne directement une IP littérale sans résolution DNS', async () => {
    const result = await resolveHostAddresses('127.0.0.1', () => {
      throw new Error('ne devrait jamais être appelé pour une IP littérale');
    });
    expect(result).toEqual([{ address: '127.0.0.1', family: 4 }]);
  });

  it('appelle onLookupFailure si la résolution DNS échoue', async () => {
    await expect(
      resolveHostAddresses('ce-domaine-nexiste-vraiment-pas-du-tout.invalid', () => {
        throw new Error('résolution échouée');
      }),
    ).rejects.toThrow('résolution échouée');
  });
});
