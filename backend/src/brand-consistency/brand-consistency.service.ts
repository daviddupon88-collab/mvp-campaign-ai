import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AiGatewayService } from '../ai/ai-gateway/ai-gateway.service';

export interface BrandCheckInputText {
  label: string;
  text: string;
}

export interface BrandCheckInputImage {
  label: string;
  url: string;
}

export interface BrandConsistencyRunResult {
  overallScore: number | null; // null si aucun Brand Kit renseigné — pas de pénalité, juste pas de mesure
  checks: Array<{ label: string; score: number; summary: string }>;
}

type BrandCtx = { organizationId: string; campaignId: string; purpose: 'brand_consistency' };

// Différenciateur produit (au-delà du garde-fou de sécurité qu'est ModerationService) :
// vérifie qu'une génération respecte réellement le Brand Kit — ton éditorial, valeurs,
// palette de couleurs — avant même que le contenu n'atteigne l'écran de validation humaine.
// Contrairement à la modération, un score bas n'entraîne JAMAIS de rejet automatique :
// la cohérence de marque est une question de jugement éditorial, pas de sécurité/légalité.
//
// ÉCONOMIE DE L'IA : tous les appels IA passent par AiGatewayService (purpose
// 'brand_consistency'), plus aucun `fetch()` direct — même correction que ModerationService.
@Injectable()
export class BrandConsistencyService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly aiGateway: AiGatewayService,
  ) {}

  private useMock(): boolean {
    return this.config.get<string>('AI_MODE', 'mock') === 'mock';
  }

  async runCampaignBrandCheck(
    organizationId: string,
    campaignId: string,
    texts: BrandCheckInputText[],
    images: BrandCheckInputImage[],
  ): Promise<BrandConsistencyRunResult> {
    const brandKit = await this.prisma.brandKit.findUnique({ where: { organizationId } });

    // Pas de Brand Kit renseigné : on ne peut rien évaluer. On ne pénalise pas la campagne,
    // mais on encourage l'utilisateur à compléter son Brand Kit (levier produit, pas garde-fou).
    if (!brandKit) {
      return { overallScore: null, checks: [] };
    }

    const ctx: BrandCtx = { organizationId, campaignId, purpose: 'brand_consistency' };
    const checks: BrandConsistencyRunResult['checks'] = [];

    for (const input of texts) {
      const result = await this.scoreText(ctx, input.text, brandKit);
      await this.persistCheck(organizationId, campaignId, input.label, 'openai-brand-text', result);
      checks.push({ label: input.label, score: result.score, summary: result.summary });
    }

    for (const input of images) {
      const result = await this.scoreImage(ctx, input.url, brandKit);
      await this.persistCheck(organizationId, campaignId, input.label, 'openai-brand-vision', result);
      checks.push({ label: input.label, score: result.score, summary: result.summary });
    }

    const overallScore = checks.length
      ? Math.round(checks.reduce((sum, c) => sum + c.score, 0) / checks.length)
      : null;

    return { overallScore, checks };
  }

  private async persistCheck(
    organizationId: string,
    campaignId: string,
    label: string,
    provider: string,
    result: { score: number; summary: string; issues?: unknown },
  ) {
    await this.prisma.brandConsistencyCheck.create({
      data: {
        organizationId,
        campaignId,
        label,
        score: result.score,
        provider,
        summary: result.summary,
        issues: (result.issues as any) ?? undefined,
      },
    });
  }

  // Compare un texte généré au ton éditorial et aux valeurs déclarées dans le Brand Kit.
  private async scoreText(
    ctx: BrandCtx,
    text: string,
    brandKit: { toneOfVoice: string | null; valueProps: unknown },
  ): Promise<{ score: number; summary: string; issues?: unknown }> {
    if (this.useMock()) {
      return { score: 82, summary: '(simulation) cohérence de ton correcte' };
    }
    try {
      const prompt = `Tu évalues si un texte marketing respecte l'identité de marque suivante :
Ton éditorial attendu : ${brandKit.toneOfVoice ?? 'non précisé'}
Arguments clés de la marque : ${JSON.stringify(brandKit.valueProps ?? [])}

Texte à évaluer :
"""${text}"""

Réponds UNIQUEMENT en JSON strict :
{"score":0-100,"summary":"phrase courte","issues":[{"issue":"...","suggestion":"..."}]}
Le score reflète l'adéquation du ton et la présence des arguments clés — pas la qualité rédactionnelle générale.`;

      const result = await this.aiGateway.generateText(ctx, { prompt }, 'openai');
      const parsed = JSON.parse(result.content);
      return { score: parsed.score, summary: parsed.summary, issues: parsed.issues };
    } catch (error) {
      // En cas d'échec, score neutre plutôt qu'une note pénalisante injustifiée.
      return { score: 50, summary: `Évaluation indisponible (${error})` };
    }
  }

  // Compare un visuel généré à la palette de couleurs et au style déclarés dans le Brand Kit.
  private async scoreImage(
    ctx: BrandCtx,
    imageUrl: string,
    brandKit: { colorPalette: unknown; toneOfVoice: string | null },
  ): Promise<{ score: number; summary: string; issues?: unknown }> {
    if (this.useMock()) {
      return { score: 78, summary: '(simulation) palette globalement alignée' };
    }
    try {
      const prompt = `Tu évalues si ce visuel publicitaire respecte l'identité visuelle de marque suivante :
Palette de couleurs attendue : ${JSON.stringify(brandKit.colorPalette ?? 'non précisée')}
Style/ton général de la marque : ${brandKit.toneOfVoice ?? 'non précisé'}

Réponds UNIQUEMENT en JSON strict :
{"score":0-100,"summary":"phrase courte","issues":[{"issue":"...","suggestion":"..."}]}`;

      const result = await this.aiGateway.analyzeImage(ctx, { prompt, imageUrl }, 'openai');
      const parsed = JSON.parse(result.content);
      return { score: parsed.score, summary: parsed.summary, issues: parsed.issues };
    } catch (error) {
      return { score: 50, summary: `Évaluation indisponible (${error})` };
    }
  }

  async listChecksForCampaign(organizationId: string, campaignId: string) {
    return this.prisma.brandConsistencyCheck.findMany({
      where: { organizationId, campaignId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
