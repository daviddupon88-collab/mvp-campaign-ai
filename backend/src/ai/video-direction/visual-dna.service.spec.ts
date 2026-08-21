import { VisualDnaService } from './visual-dna.service';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';

function buildGatewayMock(analyzeImageContent: string) {
  return {
    analyzeImage: jest.fn(async () => ({
      content: analyzeImageContent,
      provider: 'openai',
      model: 'gpt-vision',
      durationMs: 10,
    })),
  } as unknown as AiGatewayService;
}

const CTX = { organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' as const };

describe('VisualDnaService.extract', () => {
  it('JSON bien formé : tous les champs sont mappés depuis la réponse', async () => {
    const gateway = buildGatewayMock(
      JSON.stringify({
        productCategory: 'chaussures de course',
        colors: ['bleu marine', 'blanc'],
        materials: ['mesh', 'caoutchouc'],
        shape: 'silhouette basse, semelle épaisse',
        distinctiveFeatures: ['bande réfléchissante', 'semelle crantée'],
        logoOrBrandMarks: 'logo brodé sur le talon',
      }),
    );
    const service = new VisualDnaService(gateway);

    const dna = await service.extract(CTX, 'https://example.com/photo.png');

    expect(dna.productCategory).toBe('chaussures de course');
    expect(dna.colors).toEqual(['bleu marine', 'blanc']);
    expect(dna.materials).toEqual(['mesh', 'caoutchouc']);
    expect(dna.shape).toBe('silhouette basse, semelle épaisse');
    expect(dna.distinctiveFeatures).toEqual(['bande réfléchissante', 'semelle crantée']);
    expect(dna.logoOrBrandMarks).toBe('logo brodé sur le talon');
  });

  it('JSON malformé aux 2 tentatives : repli sur des valeurs neutres, raw préservé, isFallback=true, ne lève jamais (audit forensique Mission 4.2, P0-1)', async () => {
    const gateway = buildGatewayMock('Désolé, je ne peux pas analyser cette image.');
    const service = new VisualDnaService(gateway);

    const dna = await service.extract(CTX, 'https://example.com/photo.png');

    expect(dna.productCategory).toBe('non déterminée');
    expect(dna.colors).toEqual([]);
    expect(dna.logoOrBrandMarks).toBeNull();
    expect(dna.raw).toBe('Désolé, je ne peux pas analyser cette image.');
    expect(dna.isFallback).toBe(true);
    expect(gateway.analyzeImage).toHaveBeenCalledTimes(2);
  });

  it('1ère tentative malformée, 2e exploitable : retour de la 2e tentative, isFallback=false (audit forensique Mission 4.2, P0-1)', async () => {
    const gateway = {
      analyzeImage: jest
        .fn()
        .mockResolvedValueOnce({ content: 'Désolé, illisible.', provider: 'openai', model: 'gpt-vision', durationMs: 10 })
        .mockResolvedValueOnce({
          content: JSON.stringify({ productCategory: 'sac', colors: ['noir'], materials: [], shape: '', distinctiveFeatures: [], logoOrBrandMarks: null }),
          provider: 'openai',
          model: 'gpt-vision',
          durationMs: 10,
        }),
    } as unknown as AiGatewayService;
    const service = new VisualDnaService(gateway);

    const dna = await service.extract(CTX, 'https://example.com/photo.png');

    expect(dna.productCategory).toBe('sac');
    expect(dna.colors).toEqual(['noir']);
    expect(dna.isFallback).toBe(false);
    expect(gateway.analyzeImage).toHaveBeenCalledTimes(2);
  });

  it('logoOrBrandMarks absent (null explicite du modèle) : reste null, pas une chaîne "null"', async () => {
    const gateway = buildGatewayMock(
      JSON.stringify({ productCategory: 'sac', colors: [], materials: [], shape: '', distinctiveFeatures: [], logoOrBrandMarks: null }),
    );
    const service = new VisualDnaService(gateway);

    const dna = await service.extract(CTX, 'https://example.com/photo.png');

    expect(dna.logoOrBrandMarks).toBeNull();
  });

  it('échec total de analyzeImage (tous fournisseurs indisponibles) : l\'erreur remonte, jamais masquée', async () => {
    const gateway = { analyzeImage: jest.fn().mockRejectedValue(new Error('tous les fournisseurs ont échoué')) } as unknown as AiGatewayService;
    const service = new VisualDnaService(gateway);

    await expect(service.extract(CTX, 'https://example.com/photo.png')).rejects.toThrow('tous les fournisseurs ont échoué');
  });

  it('transmet bien productDescription en indice au prompt quand fourni', async () => {
    const gateway = buildGatewayMock(
      JSON.stringify({ productCategory: 'x', colors: [], materials: [], shape: '', distinctiveFeatures: [], logoOrBrandMarks: null }),
    );
    const service = new VisualDnaService(gateway);

    await service.extract(CTX, 'https://example.com/photo.png', 'Sac à dos étanche 20L');

    const [, params, provider] = (gateway.analyzeImage as jest.Mock).mock.calls[0];
    expect(params.prompt).toContain('Sac à dos étanche 20L');
    expect(provider).toBe('openai');
  });
});
