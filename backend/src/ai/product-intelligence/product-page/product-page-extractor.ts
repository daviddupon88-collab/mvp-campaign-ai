import * as cheerio from 'cheerio';
import { ProductUrlFacts, ProductSpecification, ProductUrlExtractionMethod } from './product-url-facts.types';
import { buildProductPageClaims } from './product-page-claim-builder';

// Mission 4.4 (Product URL Intelligence, Phase D) — extraction PUREMENT DÉTERMINISTE (aucun
// appel LLM, cf. shot-plan-validator.ts/preflight-quality-gate.ts pour la même discipline
// ailleurs dans ce backend). Priorité JSON-LD > OpenGraph > HTML générique — jamais l'inverse :
// le JSON-LD structuré est la source la plus fiable quand disponible.
interface JsonLdProduct {
  name?: string;
  brand?: string;
  description?: string;
  images: string[];
  specifications: ProductSpecification[];
  price?: { amount: number; currency: string };
  availability?: string;
}

export function extractProductPageFacts(html: string, url: string): ProductUrlFacts {
  const $ = cheerio.load(html);
  const warnings: string[] = [];
  const methods = new Set<Exclude<ProductUrlExtractionMethod, 'LLM' | 'MIXED'>>();

  const jsonLd = extractJsonLdProduct($, warnings);
  if (jsonLd) methods.add('JSON_LD');

  const og = extractOpenGraph($);
  if (og.title || og.description || og.image) methods.add('OPENGRAPH');

  const htmlFallback = extractHtmlFallback($);

  const title = jsonLd?.name ?? og.title ?? htmlFallback.title;
  const description = jsonLd?.description ?? og.description ?? htmlFallback.description;
  const specifications = (jsonLd?.specifications.length ? jsonLd.specifications : htmlFallback.specifications);
  if (!jsonLd && (htmlFallback.title || htmlFallback.description || specifications.length > 0)) methods.add('HTML');

  const images = dedupe([...(jsonLd?.images ?? []), ...(og.image ? [og.image] : [])]);

  const extractionMethod: ProductUrlExtractionMethod = methods.size > 1 ? 'MIXED' : methods.size === 1 ? [...methods][0] : 'HTML';

  // Mission 4.5 (Phase 1 — instrumentation) — compte par palier, additif : extractionMethod
  // résumait déjà QUEL palier a contribué, mais jamais COMBIEN de faits chacun a apporté.
  // OpenGraph ne contribue jamais de `specifications` (aucune structure clé/valeur dans OG,
  // seulement title/description/image) — compté ici comme nombre de champs OG présents.
  const jsonLdFactCount = jsonLd?.specifications.length ?? 0;
  const openGraphFactCount = [og.title, og.description, og.image].filter(Boolean).length;
  const htmlFactCount = jsonLd ? 0 : htmlFallback.specifications.length;

  const claims = buildProductPageClaims({
    title,
    brand: jsonLd?.brand,
    specifications,
    price: jsonLd?.price,
    availability: jsonLd?.availability,
  });

  return {
    sourceUrl: url,
    title,
    brand: jsonLd?.brand,
    category: undefined,
    description,
    specifications,
    claims,
    images,
    price: jsonLd?.price,
    availability: jsonLd?.availability,
    extractionMethod,
    warnings,
    jsonLdFactCount,
    openGraphFactCount,
    htmlFactCount,
  };
}

// Cherche tous les blocs <script type="application/ld+json">, gère un objet unique, un tableau
// d'objets, et un @graph — retient le premier schéma dont @type inclut 'Product' (gère @type en
// string OU en tableau, cf. variations réelles observées sur les sites e-commerce).
function extractJsonLdProduct($: cheerio.CheerioAPI, warnings: string[]): JsonLdProduct | null {
  const scripts = $('script[type="application/ld+json"]').toArray();
  for (const script of scripts) {
    const raw = $(script).contents().text();
    if (!raw.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      warnings.push('Bloc JSON-LD malformé ignoré.');
      continue;
    }

    const candidates = flattenJsonLd(parsed);
    for (const candidate of candidates) {
      if (isProductSchema(candidate)) {
        return parseJsonLdProduct(candidate);
      }
    }
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function flattenJsonLd(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(flattenJsonLd);
  if (node && typeof node === 'object') {
    const graph = node['@graph'];
    if (Array.isArray(graph)) return [node, ...graph.flatMap(flattenJsonLd)];
    return [node];
  }
  return [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isProductSchema(node: any): boolean {
  const type = node?.['@type'];
  if (typeof type === 'string') return type === 'Product';
  if (Array.isArray(type)) return type.includes('Product');
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseJsonLdProduct(node: any): JsonLdProduct {
  const brand = typeof node.brand === 'string' ? node.brand : node.brand?.name;
  const images = Array.isArray(node.image) ? node.image.filter((i: unknown) => typeof i === 'string') : typeof node.image === 'string' ? [node.image] : [];

  const specifications: ProductSpecification[] = [];
  if (node.sku) specifications.push({ key: 'SKU', value: String(node.sku) });
  if (node.gtin13) specifications.push({ key: 'GTIN-13', value: String(node.gtin13) });
  if (node.gtin) specifications.push({ key: 'GTIN', value: String(node.gtin) });
  if (node.mpn) specifications.push({ key: 'MPN', value: String(node.mpn) });
  if (Array.isArray(node.additionalProperty)) {
    for (const prop of node.additionalProperty) {
      if (prop?.name && prop?.value !== undefined) {
        specifications.push({ key: String(prop.name), value: String(prop.value), unit: prop.unitText ? String(prop.unitText) : undefined });
      }
    }
  }

  const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
  let price: { amount: number; currency: string } | undefined;
  if (offer && offer.price !== undefined && offer.priceCurrency) {
    const amount = typeof offer.price === 'string' ? parseFloat(offer.price) : offer.price;
    if (Number.isFinite(amount)) price = { amount, currency: String(offer.priceCurrency) };
  }
  const availability = typeof offer?.availability === 'string' ? offer.availability.replace('https://schema.org/', '') : undefined;

  return {
    name: typeof node.name === 'string' ? node.name : undefined,
    brand,
    description: typeof node.description === 'string' ? node.description : undefined,
    images,
    specifications,
    price,
    availability,
  };
}

function extractOpenGraph($: cheerio.CheerioAPI): { title?: string; description?: string; image?: string } {
  const title = $('meta[property="og:title"]').attr('content');
  const description = $('meta[property="og:description"]').attr('content');
  const image = $('meta[property="og:image"]').attr('content');
  return { title: title || undefined, description: description || undefined, image: image || undefined };
}

function extractHtmlFallback($: cheerio.CheerioAPI): { title?: string; description?: string; specifications: ProductSpecification[] } {
  const title = $('title').first().text().trim() || undefined;
  const description = $('meta[name="description"]').attr('content')?.trim() || undefined;

  // Tables de spécifications : recherche large (structure réelle très variable d'un site à
  // l'autre) — retient les lignes à 2 cellules exploitables (clé/valeur), ignore le reste.
  const specifications: ProductSpecification[] = [];
  $('table').each((_, table) => {
    $(table)
      .find('tr')
      .each((__, row) => {
        const cells = $(row).find('td, th');
        if (cells.length === 2) {
          const key = $(cells[0]).text().trim();
          const value = $(cells[1]).text().trim();
          if (key && value && key.length < 80 && value.length < 200) {
            specifications.push({ key, value });
          }
        }
      });
  });

  return { title, description, specifications };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
