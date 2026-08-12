import { AiOrchestratorService } from './ai-orchestrator.service';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { BrandContextBuilderService } from '../../brand/brand-context-builder.service';

function buildBrandContextMock(text = '') {
  const build = jest.fn().mockResolvedValue({ text, rules: [], entriesUsed: [] });
  return { build } as unknown as BrandContextBuilderService;
}

// Contexte de marque vide par défaut — les tests existants (avant l'intégration du Lot D)
// vérifient un comportement inchangé quand aucune donnée de marque n'est configurée.
const brandContext = buildBrandContextMock();

function buildGatewayMock(textResponses: Record<string, string> = {}, analyzeImageResponse?: string) {
  const generateText = jest.fn(async (_ctx: any, params: { prompt: string }, provider?: string) => {
    // Le canal est identifiable dans le prompt via son mot-clé distinctif (cf. buildChannelPrompt)
    // — le mock retourne une réponse adaptée si fournie, sinon un texte générique par défaut.
    const key = Object.keys(textResponses).find((k) => params.prompt.includes(k));
    return {
      content: key ? textResponses[key] : `[texte généré] ${params.prompt.slice(0, 30)}`,
      provider: provider ?? 'openai',
      model: 'test-model',
      durationMs: 10,
    };
  });
  const generateImage = jest.fn(async () => ({ content: 'https://example.com/image.png', provider: 'flux', model: 'flux-1', durationMs: 10 }));
  const generateVideo = jest.fn(async () => ({ content: 'https://example.com/video.mp4', provider: 'google-veo', model: 'veo-1', durationMs: 10 }));
  const analyzeImage = jest.fn(async () => ({
    content:
      analyzeImageResponse ??
      JSON.stringify({ category: 'Chaussures', priceRange: '80 – 120 €', strengths: ['Confort', 'Durabilité'], usp: 'Amorti premium à prix accessible' }),
    provider: 'openai',
    model: 'test-vision-model',
    durationMs: 10,
  }));

  return { generateText, generateImage, generateVideo, analyzeImage } as unknown as AiGatewayService;
}

const BASE_PARAMS = { organizationId: 'org-1', campaignId: 'camp-1', productDescription: 'Chaussures de course', objective: 'Vendre 100 paires' };

describe('AiOrchestratorService — génération spécifique par canal', () => {
  it('génère un appel generateText DISTINCT pour chaque canal sélectionné, jamais un texte partagé', async () => {
    const gateway = buildGatewayMock();
    const service = new AiOrchestratorService(gateway, brandContext);

    const result = await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram', 'facebook', 'linkedin'] });

    // 2 appels de fondation (analyse + stratégie) + 1 par canal = 5 au total.
    expect((gateway.generateText as jest.Mock).mock.calls.length).toBe(5);
    expect(Object.keys(result.channelContent)).toEqual(['instagram', 'facebook', 'linkedin']);
    // Le point central de ce chantier : chaque canal a bien reçu un prompt DIFFÉRENT,
    // jamais le même texte dupliqué comme c'était le cas auparavant.
    const prompts = (gateway.generateText as jest.Mock).mock.calls.slice(2).map((c) => c[1].prompt);
    expect(new Set(prompts).size).toBe(3);
  });

  it('adapte le prompt Instagram : texte court + hashtags', async () => {
    const gateway = buildGatewayMock();
    const service = new AiOrchestratorService(gateway, brandContext);
    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    const instagramPrompt = (gateway.generateText as jest.Mock).mock.calls[2][1].prompt;
    expect(instagramPrompt).toContain('Instagram');
    expect(instagramPrompt).toContain('hashtag');
    expect(instagramPrompt).toContain('courte');
  });

  it('adapte le prompt LinkedIn : argumentation B2B professionnelle, et route vers Anthropic', async () => {
    const gateway = buildGatewayMock();
    const service = new AiOrchestratorService(gateway, brandContext);
    await service.generateCampaign({ ...BASE_PARAMS, channels: ['linkedin'] });

    const call = (gateway.generateText as jest.Mock).mock.calls[2];
    expect(call[1].prompt).toContain('LinkedIn');
    expect(call[1].prompt).toContain('professionnel');
    expect(call[2]).toBe('anthropic'); // raisonnement B2B -> modèle plus fort, pas le modèle économique par défaut
  });

  it('adapte le prompt Facebook : ton conversationnel', async () => {
    const gateway = buildGatewayMock();
    const service = new AiOrchestratorService(gateway, brandContext);
    await service.generateCampaign({ ...BASE_PARAMS, channels: ['facebook'] });

    const prompt = (gateway.generateText as jest.Mock).mock.calls[2][1].prompt;
    expect(prompt).toContain('Facebook');
    expect(prompt).toContain('conversationnel');
  });

  it('adapte le prompt TikTok : hook court + script vidéo par plans', async () => {
    const gateway = buildGatewayMock();
    const service = new AiOrchestratorService(gateway, brandContext);
    await service.generateCampaign({ ...BASE_PARAMS, channels: ['tiktok'] });

    const prompt = (gateway.generateText as jest.Mock).mock.calls[2][1].prompt;
    expect(prompt).toContain('hook');
    expect(prompt).toContain('Plan 1');
  });

  it('réutilise le script TikTok généré comme base du prompt vidéo, pas un prompt générique déconnecté', async () => {
    const gateway = buildGatewayMock({ TikTok: 'Hook: Regardez ça !\nPlan 1 — gros plan produit' });
    const service = new AiOrchestratorService(gateway, brandContext);
    await service.generateCampaign({ ...BASE_PARAMS, channels: ['tiktok'] });

    const videoPrompt = (gateway.generateVideo as jest.Mock).mock.calls[0][1].prompt;
    expect(videoPrompt).toContain('Script de référence');
    expect(videoPrompt).toContain('Regardez ça');
  });

  describe('Google Ads — validation stricte des contraintes publicitaires', () => {
    it('parse le JSON, tronque les titres à 30 caractères et les descriptions à 90', async () => {
      const longHeadline = 'Cette accroche fait bien plus de trente caractères de long';
      const longDescription = 'Cette description dépasse largement la limite de quatre-vingt-dix caractères autorisée par Google Ads pour une annonce responsive';
      const gateway = buildGatewayMock({
        'Google Ads': JSON.stringify({ headlines: [longHeadline, 'Court', 'Aussi court'], descriptions: [longDescription, 'Description courte'] }),
      });
      const service = new AiOrchestratorService(gateway, brandContext);

      const result = await service.generateCampaign({ ...BASE_PARAMS, channels: ['googleads'] });
      const content = result.channelContent.googleads.content;

      // Aucune ligne de titre ne doit dépasser 30 caractères (hors numérotation "1. ").
      const headlineLines = content.split('\n').filter((l) => /^\d+\. /.test(l)).slice(0, 3);
      for (const line of headlineLines) {
        const text = line.replace(/^\d+\. /, '');
        expect(text.length).toBeLessThanOrEqual(30);
      }
      expect(content).toContain('…'); // le titre trop long a bien été tronqué avec une ellipse
    });

    it('se rabat sur le texte brut si le modèle ne respecte pas le format JSON demandé', async () => {
      const gateway = buildGatewayMock({ 'Google Ads': 'Désolé, voici votre annonce : un texte libre, pas du JSON.' });
      const service = new AiOrchestratorService(gateway, brandContext);

      const result = await service.generateCampaign({ ...BASE_PARAMS, channels: ['googleads'] });

      // Ne plante jamais — le texte brut est conservé tel quel pour revue humaine.
      expect(result.channelContent.googleads.content).toContain('texte libre');
    });
  });

  it('sans canal spécifié, génère un seul contenu générique sous la clé "general"', async () => {
    const gateway = buildGatewayMock();
    const service = new AiOrchestratorService(gateway, brandContext);

    const result = await service.generateCampaign({ ...BASE_PARAMS, channels: [] });

    expect(Object.keys(result.channelContent)).toEqual(['general']);
  });
});

describe('AiOrchestratorService — analyse produit par photo ("une photo suffit")', () => {
  const IMAGE_PARAMS = { organizationId: 'org-1', campaignId: 'camp-1', objective: 'Vendre 100 paires', productImageUrl: 'https://cdn.example.com/product.png' };

  it('sans productImageUrl, analyzeImage n\'est jamais appelé — chemin texte-seul historique inchangé', async () => {
    const gateway = buildGatewayMock();
    const service = new AiOrchestratorService(gateway, brandContext);

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    expect(gateway.analyzeImage as jest.Mock).not.toHaveBeenCalled();
    expect((gateway.generateText as jest.Mock).mock.calls[0][1].prompt).toContain('Analyse ce produit');
  });

  it('avec productImageUrl, analyzeImage est appelé avec le prompt vision et l\'URL de la photo, à la place de generateText pour l\'analyse', async () => {
    const gateway = buildGatewayMock();
    const service = new AiOrchestratorService(gateway, brandContext);

    await service.generateCampaign({ ...IMAGE_PARAMS, channels: ['instagram'] });

    expect(gateway.analyzeImage as jest.Mock).toHaveBeenCalledTimes(1);
    const [, callParams] = (gateway.analyzeImage as jest.Mock).mock.calls[0];
    expect(callParams.imageUrl).toBe('https://cdn.example.com/product.png');
    expect(callParams.prompt).toContain('Observe cette photo de produit');
    expect(callParams.prompt).toContain('JSON strict');
  });

  it('recoupe la description texte fournie avec la photo dans le prompt vision, quand les deux sont présents', async () => {
    const gateway = buildGatewayMock();
    const service = new AiOrchestratorService(gateway, brandContext);

    await service.generateCampaign({ ...IMAGE_PARAMS, productDescription: 'Chaussures de course', channels: ['instagram'] });

    const [, callParams] = (gateway.analyzeImage as jest.Mock).mock.calls[0];
    expect(callParams.prompt).toContain('à recouper avec ce que montre la photo');
    expect(callParams.prompt).toContain('Chaussures de course');
  });

  it('formate le JSON d\'analyse vision en texte lisible, réutilisé comme productDescription effective quand aucun texte n\'a été saisi', async () => {
    const gateway = buildGatewayMock();
    const service = new AiOrchestratorService(gateway, brandContext);

    const result = await service.generateCampaign({ ...IMAGE_PARAMS, channels: ['instagram'] });

    expect(result.productAnalysis.content).toContain('Catégorie détectée : Chaussures');
    expect(result.productAnalysis.content).toContain('USP : Amorti premium à prix accessible');
    // La description effective (dérivée de la photo) alimente bien le prompt du canal en aval.
    const instagramPrompt = (gateway.generateText as jest.Mock).mock.calls[1][1].prompt;
    expect(instagramPrompt).toContain('Catégorie détectée : Chaussures');
  });

  it('se rabat sur le texte brut si la réponse vision ne respecte pas le format JSON demandé, sans jamais planter', async () => {
    const gateway = buildGatewayMock({}, 'Désolé, je ne peux pas répondre en JSON, voici une description libre.');
    const service = new AiOrchestratorService(gateway, brandContext);

    const result = await service.generateCampaign({ ...IMAGE_PARAMS, channels: ['instagram'] });

    expect(result.productAnalysis.content).toContain('description libre');
  });

  it('la description utilisateur explicite reste prioritaire pour les prompts en aval, même quand une photo est aussi fournie', async () => {
    const gateway = buildGatewayMock();
    const service = new AiOrchestratorService(gateway, brandContext);

    await service.generateCampaign({ ...IMAGE_PARAMS, productDescription: 'Chaussures de course premium', channels: ['instagram'] });

    const instagramPrompt = (gateway.generateText as jest.Mock).mock.calls[1][1].prompt;
    expect(instagramPrompt).toContain('Chaussures de course premium');
    expect(instagramPrompt).not.toContain('Catégorie détectée');
  });
});

// Fix du bug racine identifié à l'audit du 2026-08-12 : BrandService.buildPromptContext()
// n'était jamais appelé nulle part — le contexte de marque n'atteignait donc jamais aucun
// prompt de génération. Ces tests vérifient que BrandContextBuilderService est désormais
// réellement consommé, avec le bon scope à chaque étape.
describe('AiOrchestratorService — intégration du contexte de marque (Lot D)', () => {
  it('injecte le contexte de marque GLOBAL (sans canal) dans le prompt de stratégie', async () => {
    const gateway = buildGatewayMock();
    const contextWithBrand = buildBrandContextMock('Mission : Rendre le sport accessible à tous.');
    const service = new AiOrchestratorService(gateway, contextWithBrand);

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    const globalCall = (contextWithBrand.build as jest.Mock).mock.calls[0][0];
    expect(globalCall.organizationId).toBe('org-1');
    expect(globalCall.channel).toBeUndefined();
    const strategyPrompt = (gateway.generateText as jest.Mock).mock.calls[1][1].prompt;
    expect(strategyPrompt).toContain('Mission : Rendre le sport accessible à tous.');
  });

  it('demande un contexte SPÉCIFIQUE À CHAQUE CANAL pour le prompt de copywriting, pas seulement le contexte global', async () => {
    const gateway = buildGatewayMock();
    const contextWithBrand = buildBrandContextMock('Règle : toujours mentionner la livraison gratuite.');
    const service = new AiOrchestratorService(gateway, contextWithBrand);

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram', 'linkedin'] });

    expect(contextWithBrand.build).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1', channel: 'instagram' }));
    expect(contextWithBrand.build).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1', channel: 'linkedin' }));

    const instagramPrompt = (gateway.generateText as jest.Mock).mock.calls[2][1].prompt;
    const linkedinPrompt = (gateway.generateText as jest.Mock).mock.calls[3][1].prompt;
    expect(instagramPrompt).toContain('Règle : toujours mentionner la livraison gratuite.');
    expect(linkedinPrompt).toContain('Règle : toujours mentionner la livraison gratuite.');
  });

  it("n'ajoute aucun bloc de contexte de marque quand aucune donnée de marque n'existe (organisation sans Brand Kit)", async () => {
    const gateway = buildGatewayMock();
    const emptyContext = buildBrandContextMock('');
    const service = new AiOrchestratorService(gateway, emptyContext);

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    const strategyPrompt = (gateway.generateText as jest.Mock).mock.calls[1][1].prompt;
    expect(strategyPrompt).not.toContain('Contexte de marque');
  });

  it("transmet l'archétype de persona du template comme persona identifiable, jamais un persona deviné", async () => {
    const gateway = buildGatewayMock();
    const contextWithBrand = buildBrandContextMock('contexte');
    const service = new AiOrchestratorService(gateway, contextWithBrand);

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'], templateHints: { personaArchetype: 'Responsable marketing PME' } });

    expect(contextWithBrand.build).toHaveBeenCalledWith(expect.objectContaining({ persona: 'Responsable marketing PME' }));
  });
});
