import { IdeogramProvider } from './ideogram.provider';
import { ConfigService } from '@nestjs/config';

// Couvre la correction de l'audit du 2026-08-13 : ce provider (fournisseur de repli pour
// generateImage) ne renseignait jamais `costEstimate`, laissant tout appel à ce fournisseur
// invisible dans le reporting de marge réelle (AiEconomicsService.getMarginSummary()).
function buildConfig() {
  return { get: () => 'test-api-key' } as unknown as ConfigService;
}

describe('IdeogramProvider.generateImage — coût réel', () => {
  it('renseigne costEstimate ($0.08/image, modèle V_2) — jamais undefined', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ url: 'https://example.com/image.png' }] }),
    }) as any;
    const provider = new IdeogramProvider(buildConfig());

    const result = await provider.generateImage({ prompt: 'test' });

    expect(result.costEstimate).toBe(0.08);
  });
});
