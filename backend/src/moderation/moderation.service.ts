import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AiGatewayService } from '../ai/ai-gateway/ai-gateway.service';

export interface ModerationInputText {
  label: string; // ex: "copywriting", "strategy" — identifie la pièce de contenu vérifiée
  text: string;
}

export interface ModerationInputImage {
  label: string;
  url: string;
}

export interface ModerationRunResult {
  verdict: 'PASSED' | 'FLAGGED' | 'BLOCKED';
  checks: Array<{ checkType: string; status: string; label: string; summary: string }>;
}

type ModerationCtx = { organizationId: string; campaignId: string; purpose: 'moderation' };

// Garde-fou avant publication (deuxième volet) : détection automatique de contenu
// problématique avant que la campagne n'atteigne le statut READY_FOR_REVIEW.
// Principe : la modération ne remplace jamais la validation humaine — elle peut
// au mieux BLOQUER automatiquement (violation grave, ex: haine/violence) pour éviter
// qu'un contenu manifestement inacceptable n'atteigne même l'écran du validateur ;
// dans tous les autres cas (PASSED ou FLAGGED), l'approbation humaine reste obligatoire.
//
// ÉCONOMIE DE L'IA : tous les appels IA de ce service passent par AiGatewayService (purpose
// 'moderation') — plus aucun `fetch()` direct vers un fournisseur. C'est ce qui garantit que
// le coût réel de la modération est journalisé et pris en compte dans les quotas, alors
// qu'il était auparavant totalement invisible.
@Injectable()
export class ModerationService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly aiGateway: AiGatewayService,
  ) {}

  private useMock(): boolean {
    return this.config.get<string>('AI_MODE', 'mock') === 'mock';
  }

  // Point d'entrée principal, appelé par le worker juste après la génération de contenu.
  // Journalise chaque vérification individuellement (audit) puis calcule un verdict global.
  async runCampaignModeration(
    organizationId: string,
    campaignId: string,
    texts: ModerationInputText[],
    images: ModerationInputImage[],
  ): Promise<ModerationRunResult> {
    const ctx = { organizationId, campaignId, purpose: 'moderation' as const };
    const checks: ModerationRunResult['checks'] = [];

    for (const input of texts) {
      const toxicity = await this.checkToxicity(ctx, input.text);
      await this.persistCheck(organizationId, campaignId, input.label, 'TOXICITY', toxicity);
      checks.push({ checkType: 'TOXICITY', ...toxicity, label: input.label });

      const claims = await this.checkMisleadingClaims(ctx, input.text);
      await this.persistCheck(organizationId, campaignId, input.label, 'MISLEADING_CLAIMS', claims);
      checks.push({ checkType: 'MISLEADING_CLAIMS', ...claims, label: input.label });
    }

    for (const input of images) {
      const trademark = await this.checkTrademarkInImage(ctx, input.url);
      await this.persistCheck(organizationId, campaignId, input.label, 'TRADEMARK_IMAGE', trademark);
      checks.push({ checkType: 'TRADEMARK_IMAGE', ...trademark, label: input.label });
    }

    const verdict = this.computeOverallVerdict(checks.map((c) => c.status));
    return { verdict, checks };
  }

  private computeOverallVerdict(statuses: string[]): 'PASSED' | 'FLAGGED' | 'BLOCKED' {
    if (statuses.includes('BLOCKED')) return 'BLOCKED';
    if (statuses.includes('FLAGGED')) return 'FLAGGED';
    return 'PASSED';
  }

  private async persistCheck(
    organizationId: string,
    campaignId: string,
    label: string,
    checkType: 'TOXICITY' | 'MISLEADING_CLAIMS' | 'TRADEMARK_IMAGE',
    result: { status: string; summary: string; flags?: unknown },
  ) {
    await this.prisma.moderationCheck.create({
      data: {
        organizationId,
        campaignId,
        contentId: label, // slug de la pièce de contenu — voir note dans le schéma Prisma
        checkType: checkType as any,
        status: result.status as any,
        provider: checkType === 'TOXICITY' ? 'openai-moderation' : 'openai-vision-analysis',
        summary: result.summary,
        flags: (result.flags as any) ?? undefined,
      },
    });
  }

  // Vérification 1 — Toxicité / contenu interdit (haine, violence, sexuel explicite),
  // via l'API de modération OpenAI, conçue spécifiquement pour cet usage (rapide,
  // catégorisée, sans coût de tokens de génération — cf. CREDIT_COSTS.moderation.moderateText=0).
  private async checkToxicity(ctx: ModerationCtx, text: string): Promise<{ status: string; summary: string; flags?: unknown }> {
    if (this.useMock()) {
      return { status: 'PASSED', summary: '(simulation) aucune violation détectée' };
    }
    try {
      const result = await this.aiGateway.moderateText(ctx, text);
      if (!result.flagged) {
        return { status: 'PASSED', summary: 'Aucune violation détectée' };
      }
      return {
        status: 'BLOCKED', // violation de politique de contenu = rejet automatique, pas de zone grise
        summary: `Contenu signalé : ${result.categories.join(', ')}`,
        flags: { categories: result.categories },
      };
    } catch (error) {
      // En cas d'échec du service de modération, on ne bloque pas silencieusement :
      // on FLAG pour forcer une revue humaine plutôt que de publier sans filet.
      return { status: 'FLAGGED', summary: `Vérification indisponible (${error}) — revue manuelle requise` };
    }
  }

  // Vérification 2 — Promesses commerciales trompeuses : pas couvert par l'API de
  // modération générique, nécessite un prompt métier dédié (allégations santé/finance,
  // garanties abusives, superlatifs non étayés).
  private async checkMisleadingClaims(ctx: ModerationCtx, text: string): Promise<{ status: string; summary: string; flags?: unknown }> {
    if (this.useMock()) {
      return { status: 'PASSED', summary: '(simulation) aucune promesse trompeuse détectée' };
    }
    try {
      const prompt = `Analyse ce texte marketing et détecte toute promesse commerciale trompeuse : allégations de santé non prouvées, garanties de résultat financier, superlatifs absolus non étayés ("le meilleur du monde", "100% garanti", "guérit"), comparaisons concurrentielles non vérifiables.
Réponds UNIQUEMENT en JSON strict, sans texte autour, au format :
{"severity":"none"|"low"|"medium"|"high","flags":[{"excerpt":"...","reason":"..."}]}

Texte à analyser :
"""${text}"""`;

      const result = await this.aiGateway.generateText(ctx, { prompt }, 'openai');
      const parsed = JSON.parse(result.content);

      if (parsed.severity === 'none' || !parsed.flags?.length) {
        return { status: 'PASSED', summary: 'Aucune promesse trompeuse détectée' };
      }
      const status = parsed.severity === 'high' ? 'BLOCKED' : 'FLAGGED';
      return {
        status,
        summary: `${parsed.flags.length} promesse(s) à vérifier (sévérité: ${parsed.severity})`,
        flags: parsed.flags,
      };
    } catch (error) {
      return { status: 'FLAGGED', summary: `Vérification indisponible (${error}) — revue manuelle requise` };
    }
  }

  // Vérification 3 — Marque déposée / logo tiers dans un visuel généré : utilise un modèle
  // multimodal (vision) pour décrire ce qui est visible et repérer une marque reconnaissable
  // qui ne serait pas celle du client. Approche probabiliste par nature (faux positifs/négatifs
  // possibles) — d'où un statut FLAGGED plutôt que BLOCKED : la décision finale reste humaine.
  private async checkTrademarkInImage(ctx: ModerationCtx, imageUrl: string): Promise<{ status: string; summary: string; flags?: unknown }> {
    if (this.useMock()) {
      return { status: 'PASSED', summary: '(simulation) aucune marque tierce détectée' };
    }
    try {
      const prompt = `Examine cette image publicitaire générée par IA. Identifie tout logo, marque déposée, personnage sous licence ou élément de propriété intellectuelle tiers clairement reconnaissable (Nike, Disney, Coca-Cola, etc.).
Réponds UNIQUEMENT en JSON strict :
{"detected":true|false,"brands":["..."]}`;

      const result = await this.aiGateway.analyzeImage(ctx, { prompt, imageUrl }, 'openai');
      const parsed = JSON.parse(result.content);

      if (!parsed.detected) {
        return { status: 'PASSED', summary: 'Aucune marque tierce détectée' };
      }
      return {
        status: 'FLAGGED',
        summary: `Marque(s) potentiellement détectée(s) : ${parsed.brands?.join(', ') ?? 'non précisé'} — à vérifier avant publication`,
        flags: { brands: parsed.brands },
      };
    } catch (error) {
      return { status: 'FLAGGED', summary: `Vérification indisponible (${error}) — revue manuelle requise` };
    }
  }

  async listChecksForCampaign(organizationId: string, campaignId: string) {
    return this.prisma.moderationCheck.findMany({
      where: { organizationId, campaignId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
