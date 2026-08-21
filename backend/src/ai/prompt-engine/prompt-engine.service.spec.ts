import { PromptEngineService } from './prompt-engine.service';
import { PromptTask } from './prompt-task.enum';
import { ProductVisionAnalysis } from '../product-intelligence/product-intelligence.types';

const VISION: ProductVisionAnalysis = {
  category: 'Chaussures',
  subcategory: null,
  productType: null,
  brand: 'Nike',
  productName: null,
  model: null,
  visibleText: [],
  logoDetected: true,
  packaging: null,
  colors: [],
  materials: [],
  shape: null,
  visualAttributes: [],
  distinctiveFeatures: [],
  visibleClaims: [],
  identificationClues: [],
  confidence: 0.8,
  raw: '{}',
};

// P0.5 — Prompt Engine V2. Couvre les cas demandés par le brief : contexte correct injecté,
// Product Intelligence (ici l'analyse vision) injectée, sortie structurée par template, et le
// garde-fou explicite pour une tâche non enregistrée (portée assumée, pas un faux succès silencieux).
describe('PromptEngineService.render', () => {
  it('PRODUCT_ANALYSIS : injecte le contexte (descriptionHint) et demande une sortie JSON structurée', () => {
    const engine = new PromptEngineService();

    const prompt = engine.render(PromptTask.PRODUCT_ANALYSIS, { descriptionHint: 'Une paire de baskets rouges' });

    expect(prompt).toContain('Une paire de baskets rouges');
    expect(prompt).toContain('"category"');
    expect(prompt).toContain('confidence');
  });

  it("PRODUCT_ANALYSIS sans descriptionHint : ne plante pas, ne mentionne aucune description fournie", () => {
    const engine = new PromptEngineService();

    const prompt = engine.render(PromptTask.PRODUCT_ANALYSIS, {});

    expect(prompt).not.toContain('Description fournie');
  });

  it("PRODUCT_IDENTIFICATION : injecte l'analyse vision structurée déjà extraite (Product Intelligence en amont) dans le prompt", () => {
    const engine = new PromptEngineService();

    const prompt = engine.render(PromptTask.PRODUCT_IDENTIFICATION, { vision: VISION });

    expect(prompt).toContain('Nike');
    expect(prompt).toContain('"candidates"');
  });

  it('un template enregistré expose bien role/mission/constraints/outputSchema (contrat du brief)', () => {
    const engine = new PromptEngineService();

    const template = engine.getTemplate(PromptTask.PRODUCT_ANALYSIS);

    expect(template?.role).toBeTruthy();
    expect(template?.mission).toBeTruthy();
    expect(template?.constraints.length).toBeGreaterThan(0);
    expect(template?.outputSchema).toBeTruthy();
  });

  it("une tâche NON enregistrée (ex: MARKET_ANALYSIS, hors périmètre des chantiers réalisés à ce jour) lève une erreur explicite — jamais un prompt vide silencieux", () => {
    const engine = new PromptEngineService();

    expect(() => engine.render(PromptTask.MARKET_ANALYSIS as PromptTask.PRODUCT_ANALYSIS, {})).toThrow(/aucun template enregistré/);
  });
});
