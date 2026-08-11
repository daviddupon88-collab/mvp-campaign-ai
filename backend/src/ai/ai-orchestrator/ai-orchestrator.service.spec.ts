import { AiOrchestratorService } from './ai-orchestrator.service';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';

function buildGatewayMock(textResponses: Record<string, string> = {}) {
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

  return { generateText, generateImage, generateVideo } as unknown as AiGatewayService;
}

const BASE_PARAMS = { organizationId: 'org-1', campaignId: 'camp-1', productDescription: 'Chaussures de course', objective: 'Vendre 100 paires' };

describe('AiOrchestratorService — génération spécifique par canal', () => {
  it('génère un appel generateText DISTINCT pour chaque canal sélectionné, jamais un texte partagé', async () => {
    const gateway = buildGatewayMock();
    const service = new AiOrchestratorService(gateway);

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
    const service = new AiOrchestratorService(gateway);
    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    const instagramPrompt = (gateway.generateText as jest.Mock).mock.calls[2][1].prompt;
    expect(instagramPrompt).toContain('Instagram');
    expect(instagramPrompt).toContain('hashtag');
    expect(instagramPrompt).toContain('courte');
  });

  it('adapte le prompt LinkedIn : argumentation B2B professionnelle, et route vers Anthropic', async () => {
    const gateway = buildGatewayMock();
    const service = new AiOrchestratorService(gateway);
    await service.generateCampaign({ ...BASE_PARAMS, channels: ['linkedin'] });

    const call = (gateway.generateText as jest.Mock).mock.calls[2];
    expect(call[1].prompt).toContain('LinkedIn');
    expect(call[1].prompt).toContain('professionnel');
    expect(call[2]).toBe('anthropic'); // raisonnement B2B -> modèle plus fort, pas le modèle économique par défaut
  });

  it('adapte le prompt Facebook : ton conversationnel', async () => {
    const gateway = buildGatewayMock();
    const service = new AiOrchestratorService(gateway);
    await service.generateCampaign({ ...BASE_PARAMS, channels: ['facebook'] });

    const prompt = (gateway.generateText as jest.Mock).mock.calls[2][1].prompt;
    expect(prompt).toContain('Facebook');
    expect(prompt).toContain('conversationnel');
  });

  it('adapte le prompt TikTok : hook court + script vidéo par plans', async () => {
    const gateway = buildGatewayMock();
    const service = new AiOrchestratorService(gateway);
    await service.generateCampaign({ ...BASE_PARAMS, channels: ['tiktok'] });

    const prompt = (gateway.generateText as jest.Mock).mock.calls[2][1].prompt;
    expect(prompt).toContain('hook');
    expect(prompt).toContain('Plan 1');
  });

  it('réutilise le script TikTok généré comme base du prompt vidéo, pas un prompt générique déconnecté', async () => {
    const gateway = buildGatewayMock({ TikTok: 'Hook: Regardez ça !\nPlan 1 — gros plan produit' });
    const service = new AiOrchestratorService(gateway);
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
      const service = new AiOrchestratorService(gateway);

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
      const service = new AiOrchestratorService(gateway);

      const result = await service.generateCampaign({ ...BASE_PARAMS, channels: ['googleads'] });

      // Ne plante jamais — le texte brut est conservé tel quel pour revue humaine.
      expect(result.channelContent.googleads.content).toContain('texte libre');
    });
  });

  it('sans canal spécifié, génère un seul contenu générique sous la clé "general"', async () => {
    const gateway = buildGatewayMock();
    const service = new AiOrchestratorService(gateway);

    const result = await service.generateCampaign({ ...BASE_PARAMS, channels: [] });

    expect(Object.keys(result.channelContent)).toEqual(['general']);
  });
});
