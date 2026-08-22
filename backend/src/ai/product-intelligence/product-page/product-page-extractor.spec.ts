import { extractProductPageFacts } from './product-page-extractor';

const URL = 'https://example.com/produit/gilet-securite';

function htmlWithJsonLd(json: unknown): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify(json)}</script></head><body></body></html>`;
}

describe('extractProductPageFacts — JSON-LD', () => {
  it('extrait un schéma Product simple (name, brand, description, offers, additionalProperty)', () => {
    const html = htmlWithJsonLd({
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: 'Gilet haute visibilité PRO',
      brand: { '@type': 'Brand', name: 'SafeWear' },
      description: 'Gilet réfléchissant pour chantier',
      sku: 'GHV-001',
      image: 'https://example.com/img/gilet.jpg',
      offers: { '@type': 'Offer', price: '29.90', priceCurrency: 'EUR', availability: 'https://schema.org/InStock' },
      additionalProperty: [{ '@type': 'PropertyValue', name: 'Capacité', value: '750', unitText: 'ml' }],
    });

    const result = extractProductPageFacts(html, URL);

    expect(result.extractionMethod).toBe('JSON_LD');
    expect(result.title).toBe('Gilet haute visibilité PRO');
    expect(result.brand).toBe('SafeWear');
    expect(result.description).toBe('Gilet réfléchissant pour chantier');
    expect(result.price).toEqual({ amount: 29.9, currency: 'EUR' });
    expect(result.availability).toBe('InStock');
    expect(result.images).toContain('https://example.com/img/gilet.jpg');
    expect(result.specifications).toEqual(expect.arrayContaining([
      { key: 'SKU', value: 'GHV-001' },
      { key: 'Capacité', value: '750', unit: 'ml' },
    ]));
  });

  it('gère @type en tableau (ex: ["Product","SomethingElse"])', () => {
    const html = htmlWithJsonLd({ '@type': ['Product', 'SomethingElse'], name: 'X' });
    const result = extractProductPageFacts(html, URL);
    expect(result.title).toBe('X');
    expect(result.extractionMethod).toBe('JSON_LD');
  });

  it('gère un @graph contenant plusieurs schémas et retient le Product', () => {
    const html = htmlWithJsonLd({
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'Organization', name: 'ACME' }, { '@type': 'Product', name: 'Produit dans le graph' }],
    });
    const result = extractProductPageFacts(html, URL);
    expect(result.title).toBe('Produit dans le graph');
  });

  it('gère un tableau de schémas au premier niveau', () => {
    const html = htmlWithJsonLd([{ '@type': 'BreadcrumbList' }, { '@type': 'Product', name: 'Produit tableau' }]);
    const result = extractProductPageFacts(html, URL);
    expect(result.title).toBe('Produit tableau');
  });

  it('ignore un bloc JSON-LD malformé sans planter, poursuit avec les autres sources', () => {
    const html = `<html><head><script type="application/ld+json">{not valid json</script><meta property="og:title" content="Repli OpenGraph"></head></html>`;
    const result = extractProductPageFacts(html, URL);
    expect(result.warnings).toContain('Bloc JSON-LD malformé ignoré.');
    expect(result.title).toBe('Repli OpenGraph');
    expect(result.extractionMethod).toBe('OPENGRAPH');
  });

  it('absence totale de JSON-LD Product : extractionMethod ne vaut jamais JSON_LD', () => {
    const html = '<html><head><title>Titre brut</title></head></html>';
    const result = extractProductPageFacts(html, URL);
    expect(result.extractionMethod).not.toBe('JSON_LD');
  });
});

describe('extractProductPageFacts — OpenGraph', () => {
  it('extrait og:title/og:description/og:image quand aucun JSON-LD Product', () => {
    const html = `<html><head>
      <meta property="og:title" content="Gilet OG">
      <meta property="og:description" content="Description OG">
      <meta property="og:image" content="https://example.com/og.jpg">
    </head></html>`;
    const result = extractProductPageFacts(html, URL);
    expect(result.title).toBe('Gilet OG');
    expect(result.description).toBe('Description OG');
    expect(result.images).toContain('https://example.com/og.jpg');
    expect(result.extractionMethod).toBe('OPENGRAPH');
  });
});

describe('extractProductPageFacts — HTML générique', () => {
  it('extrait <title>/meta description et une table de spécifications quand rien d\'autre n\'est disponible', () => {
    const html = `<html><head><title>Titre HTML</title><meta name="description" content="Desc HTML"></head>
      <body><table><tr><td>Poids</td><td>500g</td></tr><tr><td>Couleur</td><td>Jaune</td></tr></table></body></html>`;
    const result = extractProductPageFacts(html, URL);
    expect(result.title).toBe('Titre HTML');
    expect(result.description).toBe('Desc HTML');
    expect(result.specifications).toEqual(expect.arrayContaining([
      { key: 'Poids', value: '500g' },
      { key: 'Couleur', value: 'Jaune' },
    ]));
    expect(result.extractionMethod).toBe('HTML');
  });

  it('page sans rien d\'exploitable : title/description absents, specifications vides', () => {
    const html = '<html><head></head><body><p>Contenu générique sans structure</p></body></html>';
    const result = extractProductPageFacts(html, URL);
    expect(result.title).toBeUndefined();
    expect(result.specifications).toEqual([]);
  });
});

describe('extractProductPageFacts — MIXED', () => {
  it('JSON-LD sans description + OpenGraph avec description : extractionMethod MIXED', () => {
    const html = `<html><head>
      <script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Nom JSON-LD' })}</script>
      <meta property="og:description" content="Description OG complémentaire">
    </head></html>`;
    const result = extractProductPageFacts(html, URL);
    expect(result.extractionMethod).toBe('MIXED');
    expect(result.title).toBe('Nom JSON-LD');
    expect(result.description).toBe('Description OG complémentaire');
  });
});

describe('extractProductPageFacts — comptes par palier (Mission 4.5, Phase 1)', () => {
  it('JSON-LD pur : jsonLdFactCount = nb de specifications, openGraphFactCount=0, htmlFactCount=0', () => {
    const html = htmlWithJsonLd({
      '@type': 'Product',
      name: 'X',
      sku: 'ABC',
      additionalProperty: [{ name: 'Capacité', value: '750', unitText: 'ml' }],
    });
    const result = extractProductPageFacts(html, URL);
    expect(result.jsonLdFactCount).toBe(2); // SKU + Capacité
    expect(result.openGraphFactCount).toBe(0);
    expect(result.htmlFactCount).toBe(0);
  });

  it('OpenGraph pur (aucun JSON-LD) : openGraphFactCount = nb de champs OG présents, jsonLdFactCount=0', () => {
    const html = `<html><head>
      <meta property="og:title" content="Gilet OG">
      <meta property="og:description" content="Description OG">
    </head></html>`;
    const result = extractProductPageFacts(html, URL);
    expect(result.jsonLdFactCount).toBe(0);
    expect(result.openGraphFactCount).toBe(2); // title + description, pas d'image
    expect(result.htmlFactCount).toBe(0);
  });

  it('HTML générique pur (aucun JSON-LD) : htmlFactCount = nb de lignes de table extraites', () => {
    const html = `<html><body><table><tr><td>Poids</td><td>500g</td></tr><tr><td>Couleur</td><td>Jaune</td></tr></table></body></html>`;
    const result = extractProductPageFacts(html, URL);
    expect(result.jsonLdFactCount).toBe(0);
    expect(result.htmlFactCount).toBe(2);
  });

  it('page sans rien d\'exploitable : les 3 comptes sont à 0', () => {
    const html = '<html><body><p>Rien</p></body></html>';
    const result = extractProductPageFacts(html, URL);
    expect(result.jsonLdFactCount).toBe(0);
    expect(result.openGraphFactCount).toBe(0);
    expect(result.htmlFactCount).toBe(0);
  });
});

describe('extractProductPageFacts — claims', () => {
  it('chaque specification/prix/dispo devient une ProductClaim allowedForAdvertising=true, source PRODUCT_URL', () => {
    const html = htmlWithJsonLd({
      '@type': 'Product',
      name: 'X',
      offers: { price: '10', priceCurrency: 'EUR' },
      additionalProperty: [{ name: 'Capacité', value: '750', unitText: 'ml' }],
    });
    const result = extractProductPageFacts(html, URL);
    expect(result.claims.every((c) => c.source === 'PRODUCT_URL' && c.allowedForAdvertising)).toBe(true);
    expect(result.claims.some((c) => c.text.includes('Capacité'))).toBe(true);
    expect(result.claims.some((c) => c.text.includes('Prix'))).toBe(true);
  });

  it('aucune specification/prix/marque/dispo : aucune claim générée (jamais une claim inventée)', () => {
    const html = htmlWithJsonLd({ '@type': 'Product', name: 'X' });
    const result = extractProductPageFacts(html, URL);
    expect(result.claims).toEqual([]);
  });
});
