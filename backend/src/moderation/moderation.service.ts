import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AiGatewayService } from '../ai/ai-gateway/ai-gateway.service';
import { PROMPT_VERSIONS } from '../ai/prompt-versions';

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
    objective: string,
    texts: ModerationInputText[],
    images: ModerationInputImage[],
  ): Promise<ModerationRunResult> {
    const ctx = { organizationId, campaignId, purpose: 'moderation' as const };
    const checks: ModerationRunResult['checks'] = [];

    // checkToxicity reste par texte (endpoint de modération dédié, sans coût de tokens de
    // génération — cf. commentaire sur checkToxicity) mais désormais en parallèle plutôt que
    // séquentiel dans la boucle, rien ne dépendant de l'ordre. checkMisleadingClaims et
    // checkObjectiveAchievement sont en revanche de vrais appels `generateText` facturés — un
    // par texte aurait été le principal facteur du nombre d'appels IA constaté en conditions
    // réelles (retour utilisateur du 2026-08-17) : regroupés en UN SEUL appel chacun, couvrant
    // tous les textes de la campagne.
    const [toxicityResults, claimsByLabel, objectiveCheck] = await Promise.all([
      Promise.all(texts.map((input) => this.checkToxicity(ctx, input.text))),
      this.checkMisleadingClaimsBatch(ctx, texts),
      this.checkObjectiveAchievement(ctx, objective, texts),
    ]);

    for (let i = 0; i < texts.length; i++) {
      const input = texts[i];
      const toxicity = toxicityResults[i];
      await this.persistCheck(organizationId, campaignId, input.label, 'TOXICITY', toxicity);
      checks.push({ checkType: 'TOXICITY', ...toxicity, label: input.label });

      const claims = claimsByLabel.get(input.label) ?? {
        status: 'FLAGGED',
        summary: 'Vérification indisponible (réponse incomplète du modèle) — revue manuelle requise',
      };
      await this.persistCheck(organizationId, campaignId, input.label, 'MISLEADING_CLAIMS', claims);
      checks.push({ checkType: 'MISLEADING_CLAIMS', ...claims, label: input.label });
    }

    for (const input of images) {
      const trademark = await this.checkTrademarkInImage(ctx, input.url);
      await this.persistCheck(organizationId, campaignId, input.label, 'TRADEMARK_IMAGE', trademark);
      checks.push({ checkType: 'TRADEMARK_IMAGE', ...trademark, label: input.label });
    }

    // Vérification au niveau de la campagne entière, pas d'une pièce de contenu précise —
    // label 'campaign' et contentId qui en découle : c'est le cas prévu par le commentaire du
    // schéma Prisma sur ModerationCheck.contentId ("null si la vérification porte sur la
    // campagne dans son ensemble"), jusqu'ici jamais exercé en pratique.
    await this.persistCheck(organizationId, campaignId, 'campaign', 'OBJECTIVE_ACHIEVEMENT', objectiveCheck);
    checks.push({ checkType: 'OBJECTIVE_ACHIEVEMENT', ...objectiveCheck, label: 'campaign' });

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
    checkType: 'TOXICITY' | 'MISLEADING_CLAIMS' | 'TRADEMARK_IMAGE' | 'OBJECTIVE_ACHIEVEMENT',
    result: { status: string; summary: string; flags?: unknown },
  ) {
    await this.prisma.moderationCheck.create({
      data: {
        organizationId,
        campaignId,
        contentId: label, // slug de la pièce de contenu — voir note dans le schéma Prisma
        checkType: checkType as any,
        status: result.status as any,
        provider:
          checkType === 'TOXICITY'
            ? 'openai-moderation'
            : checkType === 'OBJECTIVE_ACHIEVEMENT'
              ? 'anthropic-objective-check' // seul check de ce service routé vers Claude (raisonnement), pas vision — cf. checkObjectiveAchievement
              : 'openai-vision-analysis',
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
  // garanties abusives, superlatifs non étayés). UN SEUL appel pour tous les textes de la
  // campagne (plutôt qu'un appel par texte) — cf. commentaire dans runCampaignModeration.
  private async checkMisleadingClaimsBatch(
    ctx: ModerationCtx,
    texts: ModerationInputText[],
  ): Promise<Map<string, { status: string; summary: string; flags?: unknown }>> {
    if (texts.length === 0) return new Map();
    if (this.useMock()) {
      return new Map(texts.map((t) => [t.label, { status: 'PASSED', summary: '(simulation) aucune promesse trompeuse détectée' }]));
    }
    try {
      const itemsBlock = texts.map((t) => `[${t.label}]\n"""${t.text}"""`).join('\n\n');
      const prompt = `Analyse chacun des textes marketing suivants (identifiés par un label entre crochets) et détecte, pour CHAQUE texte, toute promesse commerciale trompeuse : allégations de santé non prouvées, garanties de résultat financier, superlatifs absolus non étayés ("le meilleur du monde", "100% garanti", "guérit"), comparaisons concurrentielles non vérifiables.
Réponds UNIQUEMENT en JSON strict, sans texte autour : un tableau avec EXACTEMENT une entrée par label (mêmes labels que ci-dessous), au format :
[{"label":"...","severity":"none"|"low"|"medium"|"high","flags":[{"excerpt":"...","reason":"..."}]}]

Textes à analyser :
${itemsBlock}`;

      const result = await this.aiGateway.generateText(ctx, { prompt }, 'openai', PROMPT_VERSIONS.moderationMisleadingClaims);
      const parsed = JSON.parse(result.content) as Array<{ label: string; severity: string; flags?: unknown[] }>;
      const byLabel = new Map(parsed.map((item) => [item.label, item]));

      const entries: Array<[string, { status: string; summary: string; flags?: unknown }]> = texts.map((t) => {
        const item = byLabel.get(t.label);
        if (!item || item.severity === 'none' || !item.flags?.length) {
          return [t.label, { status: 'PASSED', summary: 'Aucune promesse trompeuse détectée' }];
        }
        const status = item.severity === 'high' ? 'BLOCKED' : 'FLAGGED';
        return [t.label, { status, summary: `${item.flags.length} promesse(s) à vérifier (sévérité: ${item.severity})`, flags: item.flags }];
      });
      return new Map(entries);
    } catch (error) {
      return new Map(texts.map((t) => [t.label, { status: 'FLAGGED', summary: `Vérification indisponible (${error}) — revue manuelle requise` }]));
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

      const result = await this.aiGateway.analyzeImage(ctx, { prompt, imageUrl }, 'openai', PROMPT_VERSIONS.moderationTrademark);
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

  // Vérification 4 — Atteinte de l'objectif : consigne explicite de l'utilisateur, "valider
  // seulement si l'objectif complet de campaign-ai est atteint sans exception". Contrairement
  // aux 3 checks précédents (sécurité/légalité, jamais liés à l'objectif marketing par
  // construction — cf. plan), celui-ci juge SPÉCIFIQUEMENT si le contenu généré atteint
  // l'objectif. UN SEUL appel pour toute la campagne, même principe de batching que
  // checkMisleadingClaimsBatch.
  private async checkObjectiveAchievement(
    ctx: ModerationCtx,
    objective: string,
    texts: ModerationInputText[],
  ): Promise<{ status: string; summary: string; flags?: unknown }> {
    if (this.useMock()) {
      return { status: 'PASSED', summary: "(simulation) l'objectif de la campagne est atteint" };
    }
    try {
      const itemsBlock = texts.map((t) => `[${t.label}]\n"""${t.text}"""`).join('\n\n');
      const prompt = `Objectif de la campagne : ${objective}

Voici l'ensemble du contenu généré pour cette campagne :
${itemsBlock}

Ce contenu atteint-il PLEINEMENT l'objectif ci-dessus ? Sois strict : un contenu partiellement aligné, hors-sujet, ou qui ne sert l'objectif qu'indirectement doit être jugé comme un échec — aucune exception, aucun bénéfice du doute.
Réponds UNIQUEMENT en JSON strict, sans texte autour : {"achieved": true|false, "summary": "..."}`;

      // anthropic : jugement/raisonnement, même routage que strategy/shotPlan/optimizer —
      // pas openai comme les 3 autres checks de ce service (des détections, pas un jugement).
      const result = await this.aiGateway.generateText(ctx, { prompt }, 'anthropic', PROMPT_VERSIONS.moderationObjectiveAchievement);
      const parsed = JSON.parse(result.content);
      if (typeof parsed.achieved !== 'boolean') throw new Error('champ "achieved" manquant ou invalide');

      return parsed.achieved
        ? { status: 'PASSED', summary: String(parsed.summary ?? "Objectif de la campagne atteint") }
        : { status: 'BLOCKED', summary: String(parsed.summary ?? "Objectif de la campagne non atteint") };
    } catch (error) {
      // Échec du service IA ou réponse malformée -> FLAGGED (revue humaine), PAS BLOCKED : la
      // consigne "sans exception" porte sur le JUGEMENT de l'IA quand elle a pu s'exprimer, pas
      // sur ce qu'il faut faire quand l'IA elle-même est indisponible — bloquer automatiquement
      // une campagne à cause d'une panne technique serait pire qu'un faux négatif. Même principe
      // de repli que claimsByLabel.get(...) ?? { status: 'FLAGGED', ... } plus haut.
      return { status: 'FLAGGED', summary: `Vérification d'atteinte de l'objectif indisponible (${error}) — revue manuelle requise` };
    }
  }

  async listChecksForCampaign(organizationId: string, campaignId: string) {
    return this.prisma.moderationCheck.findMany({
      where: { organizationId, campaignId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
