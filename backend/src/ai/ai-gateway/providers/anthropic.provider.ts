import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiProvider, GenerateTextParams, AiGenerationResult } from './ai-provider.interface';
import { fetchWithTimeout } from '../../../common/http/fetch-with-timeout';

// Provider Anthropic : utilisé notamment pour l'analyse stratégique / SEO
// (cf. exemple d'orchestration du chapitre 9 du business plan).
// Nécessite ANTHROPIC_API_KEY dans l'environnement.
@Injectable()
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  private readonly apiKey: string | undefined;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
  }

  async generateText(params: GenerateTextParams): Promise<AiGenerationResult> {
    const start = Date.now();
    const model = 'claude-sonnet-5';

    const response = await fetchWithTimeout(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey ?? '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          // 4000, pas 1000 : sur claude-sonnet-5, le thinking adaptatif est actif PAR DÉFAUT dès
          // que `thinking` est omis (contrairement aux générations précédentes de modèles Claude)
          // et partage le même budget que max_tokens — un plafond de 1000 tokens a été constaté en
          // conditions réelles le 2026-08-16 entièrement consommé par le raisonnement interne,
          // laissant AUCUN token pour la réponse visible (`textBlock` vide, cf. l'appel stratégie
          // de AiOrchestratorService.generateCampaign). Non corrigé en désactivant le thinking
          // (`{type:"disabled"}`) : ce provider est choisi précisément pour le raisonnement
          // stratégique (cf. commentaire ci-dessus, "routage: raisonnement stratégique -> modèle
          // plus fort") — le désactiver irait à l'encontre de l'intention du routage.
          max_tokens: params.maxTokens ?? 4000,
          messages: [{ role: 'user', content: params.prompt }],
        }),
      },
      // 60s, pas le défaut 20s : même raisonnement que OpenAiProvider — un budget de sortie plus
      // large avec thinking actif prend plus de temps que les 1000 tokens précédents. Jamais
      // confirmé en conditions réelles (l'appel Anthropic a échoué avant sur une clé API absente
      // dans ce test), mais le risque est symétrique à celui constaté côté OpenAI le 2026-08-16 —
      // corrigé préventivement plutôt que d'attendre une deuxième découverte du même problème.
      60_000,
    );

    if (!response.ok) {
      throw new Error(`Anthropic error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    const textBlock = data.content.find((b: any) => b.type === 'text');

    return {
      content: textBlock?.text ?? '',
      provider: this.name,
      model,
      tokensUsed: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      costEstimate: this.estimateCost(data.usage),
      durationMs: Date.now() - start,
    };
  }

  private estimateCost(usage: { input_tokens?: number; output_tokens?: number } | undefined): number {
    if (!usage) return 0;
    // $2/$10 par 1M tokens (input/output) — tarif d'introduction de Claude Sonnet 5, rendu
    // PERMANENT par Anthropic : la hausse prévue au 1er septembre 2026 vers $3/$15 a été
    // annulée (vérifié le 2026-08-16). L'ancien calcul ($3/$15) surestimait donc le coût réel
    // de chaque appel de 50%, en continu — pas seulement pendant une fenêtre temporaire.
    return ((usage.input_tokens ?? 0) * 0.002 + (usage.output_tokens ?? 0) * 0.01) / 1000;
  }
}
