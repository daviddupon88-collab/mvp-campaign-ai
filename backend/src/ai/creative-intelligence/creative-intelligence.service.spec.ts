import { CreativeIntelligenceService } from './creative-intelligence.service';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { PromptEngineService } from '../prompt-engine/prompt-engine.service';
import { ProductIntelligenceProfile } from '@prisma/client';

function buildGatewayMock(content: string) {
  return {
    generateText: jest.fn(async () => ({ content, provider: 'anthropic', model: 'claude-sonnet-5', durationMs: 10 })),
  } as unknown as AiGatewayService;
}

// Instance réelle (pas un mock) : exerce aussi le rendu réel du template CREATIVE_BRIEF,
// comme les autres services de ce chantier (cf. product-vision-analysis.service.spec.ts).
const promptEngine = new PromptEngineService();

const BASE_PARAMS = { objective: 'Générer des ventes directes', strategyContent: 'Cibler les familles urbaines avec un message de praticité.' };

const FULL_PROFILE = {
  category: 'Produits ménagers',
  subcategory: 'Détachants',
  brand: 'CleanPro',
  productName: 'Mousse Active',
  model: null,
  features: ['mousse dense', 'flacon spray'],
  usps: ['action rapide'],
  visibleClaims: ['Sans danger pour les tissus'],
  webResearchStatus: 'NOT_CONFIGURED',
} as unknown as ProductIntelligenceProfile;

describe('CreativeIntelligenceService.generate', () => {
  it('avec un Product Intelligence Profile : transforme intelligence produit + stratégie en 16 champs structurés', async () => {
    const gateway = buildGatewayMock(
      JSON.stringify({
        adObjective: 'Générer des ventes directes',
        targetAudience: 'Familles urbaines actives',
        primaryProblem: 'Taches tenaces sur les vêtements du quotidien',
        primaryDesire: 'Vêtements impeccables sans effort',
        primaryBenefit: 'Action rapide sur les taches',
        valueProposition: 'Une mousse qui agit vite, sans abîmer les tissus',
        creativeAngle: 'Le quotidien simplifié',
        desiredEmotion: 'Soulagement',
        hook: 'La tache qui gâchait la sortie',
        proofToShow: 'La mousse dense recouvre et dissout visuellement la tache en quelques secondes',
        objections: ['Peut abîmer le tissu'],
        mainMessage: 'Une action rapide, visible, sans risque pour le tissu',
        cta: 'Essayez maintenant',
        visualTone: 'Chaleureux et rassurant',
        pacing: 'Dynamique',
        adStyle: 'Démonstration produit',
      }),
    );
    const service = new CreativeIntelligenceService(gateway, promptEngine);

    const result = await service.generate({ organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' }, { ...BASE_PARAMS, productProfile: FULL_PROFILE });

    expect(result.targetAudience).toBe('Familles urbaines actives');
    expect(result.proofToShow).toContain('dissout');
    expect(result.objections).toEqual(['Peut abîmer le tissu']);
    expect(result.raw).toContain('Familles urbaines');
  });

  it('injecte le bloc de grounding réel (renderGroundedContext) dans le prompt quand un profil existe', async () => {
    const gateway = buildGatewayMock(JSON.stringify({ adObjective: 'x' }));
    const service = new CreativeIntelligenceService(gateway, promptEngine);

    await service.generate({ organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' }, { ...BASE_PARAMS, productProfile: FULL_PROFILE });

    const [, params] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(params.prompt).toContain('Intelligence produit');
    expect(params.prompt).toContain('CleanPro');
  });

  it("sans photo (productProfile=null) : repli sur productDescription texte, jamais un prompt vide", async () => {
    const gateway = buildGatewayMock(JSON.stringify({ adObjective: 'x' }));
    const service = new CreativeIntelligenceService(gateway, promptEngine);

    await service.generate(
      { organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' },
      { ...BASE_PARAMS, productProfile: null, productDescription: 'Sac à dos imperméable 20L' },
    );

    const [, params] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(params.prompt).toContain('Sac à dos imperméable 20L');
    expect(params.prompt).not.toContain('Intelligence produit');
  });

  it('réponse non conforme au format JSON attendu : repli neutre (tous les champs vides), ne lève jamais', async () => {
    const gateway = buildGatewayMock("Désolé, je ne peux pas répondre à cette demande.");
    const service = new CreativeIntelligenceService(gateway, promptEngine);

    const result = await service.generate({ organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' }, { ...BASE_PARAMS, productProfile: null });

    expect(result.adObjective).toBe('');
    expect(result.objections).toEqual([]);
    expect(result.raw).toContain('Désolé');
  });

  it('transmet promptVersion pour la traçabilité', async () => {
    const gateway = buildGatewayMock(JSON.stringify({ adObjective: 'x' }));
    const service = new CreativeIntelligenceService(gateway, promptEngine);

    await service.generate({ organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' }, { ...BASE_PARAMS, productProfile: null });

    const [, , , promptVersion] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(promptVersion).toBe('creative-brief-v1');
  });

  it("échec total du provider : l'erreur remonte, ne masque jamais une vraie panne", async () => {
    const gateway = { generateText: jest.fn().mockRejectedValue(new Error('tous les fournisseurs ont échoué')) } as unknown as AiGatewayService;
    const service = new CreativeIntelligenceService(gateway, promptEngine);

    await expect(
      service.generate({ organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' }, { ...BASE_PARAMS, productProfile: null }),
    ).rejects.toThrow('tous les fournisseurs ont échoué');
  });
});
