import { Injectable, Logger } from '@nestjs/common';
import { AiGatewayService, AiCallContext } from '../ai-gateway/ai-gateway.service';
import { VisualDna } from './visual-dna.service';
import { ShotQualityResult } from './video-analyzer.service';
import { PROMPT_VERSIONS } from '../prompt-versions';

// Un plan (shot) de la vidéo finale — direction artistique structurée, jamais un simple prompt
// texte libre. C'est ce qui sépare la RÉFLEXION créative (cette structure) de l'EXÉCUTION (Veo,
// qui ne fait plus qu'exécuter un plan déjà décidé) — cf. le constat qui a motivé toute cette
// architecture : un prompt texte unique demandait à Veo de comprendre le produit, inventer le
// scénario ET cadrer/filmer en même temps, ce qui produisait un résultat générique et statique.
export interface Shot {
  camera: string;
  subject: string;
  motion: string;
  lighting: string;
  background: string;
  // NOUVEAU (chantier Storyboard, 2026-08-18) : rôle de CE plan dans l'arc narratif (ex: "hook",
  // "démonstration du bénéfice", "payoff / rappel de marque") — assure une continuité entre les
  // plans plutôt que 3 angles esthétiques indépendants sans lien entre eux. Optionnel et additif
  // : un Shot sans ce champ (ancien code, tests existants, DEFAULT_SHOT_PLAN avant ce chantier)
  // reste valide, serializeShotToPrompt() n'ajoute simplement pas la ligne de contexte narratif.
  narrativeRole?: string;
}
export type ShotPlan = Shot[];

export interface GenerateShotPlanParams {
  visualDna: VisualDna;
  productDescription: string;
  objective: string; // objectif de campagne — champ dédié plutôt que noyé dans campaignContext, pour rester explicite même si la stratégie est longue (chantier "prompts précis, orientés objectif" du 2026-08-18)
  campaignContext: string; // texte de stratégie déjà généré — ancre le Shot Plan dans l'angle marketing retenu, pas une improvisation déconnectée
  narrationHint?: string; // narration déjà calculée (voir AiOrchestratorService) — aide au rythme/nombre de plans, jamais lu tel quel par Veo
}

// Repli total (réponse totalement inexploitable) ET comblement partiel (le modèle renvoie
// moins de plans que demandé) — l'exemple concret donné lors de la conception de cette
// architecture : un travelling avant avec rotation lente, une orbite à 45° qui poursuit la
// rotation, un plan serré sur le logo. Un vrai repli délibéré, pas un placeholder vide.
export const DEFAULT_SHOT_PLAN: ShotPlan = [
  {
    camera: 'slow cinematic push-in',
    subject: 'product',
    motion: 'the product rotates slowly',
    lighting: 'a moving highlight sweeps across the product',
    background: 'subtle floating particles move through the scene',
    narrativeRole: 'hook',
  },
  {
    camera: 'smooth 45-degree orbit',
    subject: 'product',
    motion: 'rotation continues at a steady pace',
    lighting: 'a stronger light sweep travels from left to right',
    background: 'subtle floating particles move through the scene',
    narrativeRole: 'demonstration',
  },
  {
    camera: 'close-up',
    subject: 'logo',
    motion: 'slight push-in',
    lighting: 'a focused highlight on the logo',
    background: 'softly blurred product surface',
    narrativeRole: 'payoff',
  },
];

// Video Director : transforme l'ADN visuel + le contexte de campagne en un Shot Plan structuré
// (un raisonnement créatif, pas une génération vidéo) — Veo (ou tout autre fournisseur vidéo)
// ne fait plus qu'exécuter chaque plan déjà décidé ici, cf. AiOrchestratorService qui consomme
// ce Shot Plan un plan à la fois.
@Injectable()
export class VideoDirectorService {
  private readonly logger = new Logger(VideoDirectorService.name);

  constructor(private readonly aiGateway: AiGatewayService) {}

  async generateShotPlan(ctx: AiCallContext, params: GenerateShotPlanParams, shotCount = 3): Promise<ShotPlan> {
    const narrationBlock = params.narrationHint ? `\nNarration prévue (pour caler le rythme des plans, ne pas la réciter) : ${params.narrationHint}` : '';
    const prompt = `Tu es le réalisateur d'une publicité produit courte et dynamique. Voici l'identité visuelle du produit (à préserver dans chaque plan) :
${JSON.stringify(params.visualDna)}

Objectif de la campagne : ${params.objective}
Description produit : ${params.productDescription}
Contexte de campagne : ${params.campaignContext}${narrationBlock}

Avant de concevoir les plans, détermine un arc narratif court en ${shotCount} temps (ex: accroche, démonstration du bénéfice, conclusion/rappel de marque) — les plans ne doivent JAMAIS être des angles esthétiques interchangeables sans lien entre eux, mais une progression qui se répond d'un plan à l'autre.
Conçois exactement ${shotCount} plans qui, mis bout à bout, forment une publicité premium dynamique — jamais un plan fixe, toujours un mouvement de caméra continu.
Réponds UNIQUEMENT en JSON strict, sans texte autour : un tableau d'EXACTEMENT ${shotCount} objets, au format :
[{"camera":"...","subject":"...","motion":"...","lighting":"...","background":"...","narrativeRole":"..."}]
"narrativeRole" décrit en quelques mots le rôle narratif de CE plan précis dans l'arc (ex: "hook", "demonstration of the benefit", "payoff / brand recall").
Les valeurs des champs doivent être en anglais (langage cinématographique standard).`;

    const result = await this.aiGateway.generateText(ctx, { prompt }, 'anthropic', PROMPT_VERSIONS.shotPlan);
    return this.parseShotPlan(result.content, shotCount);
  }

  // Reproduit le gabarit cinématographique validé pour Veo — la structure et le wording de ces
  // 7 lignes sont volontairement figés (non-régression testée), y compris la contrainte finale
  // anti-plan-fixe. `subject` est intégré dans la ligne Camera (le gabarit n'a pas de ligne
  // dédiée) plutôt que d'ajouter une 8e ligne — déviation assumée et signalée lors de la
  // conception de cette architecture.
  serializeShotToPrompt(shot: Shot): string {
    const cameraLine = shot.subject && shot.subject.trim().toLowerCase() !== 'product' ? `${shot.camera} focused on the ${shot.subject}` : shot.camera;
    // Ligne additive UNIQUEMENT si narrativeRole est renseigné (chantier Storyboard, 2026-08-18)
    // — ne touche jamais aux 7 lignes du gabarit ci-dessous, déjà validées et testées littéralement.
    const narrativeContext = shot.narrativeRole ? `This shot is the "${shot.narrativeRole}" beat of the commercial.\n` : '';

    return `${narrativeContext}Create a dynamic premium product commercial.
The product remains visually identical to the reference image.
Camera: ${cameraLine}
Motion: ${shot.motion}
Environment: ${shot.background}
Lighting: ${shot.lighting}
The movement must remain continuous throughout the entire shot.
Avoid a static camera and avoid a still-image effect.`;
  }

  // Repair Loop intelligent (chantier du 2026-08-18) : avant ce chantier, une régénération sur
  // échec qualité renvoyait EXACTEMENT le même prompt à Veo — un pur tirage aléatoire, aucun
  // diagnostic. VideoAnalyzerService calcule déjà PRÉCISÉMENT pourquoi un plan a échoué
  // (mouvement insuffisant et/ou produit méconnaissable) — ce diagnostic n'était jusqu'ici
  // jamais réinjecté dans la régénération. Construction de texte pure, AUCUN appel IA
  // supplémentaire : réutilise le budget de régénération déjà existant (2 essais/plan), juste
  // un prompt différent et ciblé au 2e essai.
  repairShotPrompt(shot: Shot, quality: ShotQualityResult): string {
    const base = this.serializeShotToPrompt(shot);
    const fixes: string[] = [];
    if (!quality.motionQuality.passed) {
      fixes.push(
        'IMPORTANT: the previous attempt was judged too static — make the camera movement and product motion MUCH more pronounced and continuous throughout, with no moment resembling a still photo.',
      );
    }
    if (!quality.visualFidelity.passed) {
      fixes.push(
        `IMPORTANT: the previous attempt did not accurately match the reference product (${quality.visualFidelity.reasons.join('; ')}) — ensure the product's exact color, shape, material and logo match the reference image precisely.`,
      );
    }
    return fixes.length > 0 ? `${base}\n\n${fixes.join('\n')}` : base;
  }

  // Parsing défensif suivant le même pattern que ModerationService.checkMisleadingClaimsBatch /
  // BrandConsistencyService.scoreTextBatch (réponse en tableau JSON, un modèle qui n'obéit pas
  // exactement au nombre demandé ne doit jamais faire échouer la génération vidéo) : complète
  // les entrées manquantes/malformées depuis DEFAULT_SHOT_PLAN (en bouclant dessus si
  // shotCount > longueur du repli), tronque tout excédent.
  private parseShotPlan(raw: string, shotCount: number): ShotPlan {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.logger.warn(`Réponse du Video Director non conforme au format JSON attendu, repli sur le Shot Plan par défaut: ${error}`);
      return this.buildFromDefaults(shotCount);
    }

    if (!Array.isArray(parsed)) {
      this.logger.warn('Réponse du Video Director : JSON valide mais pas un tableau, repli sur le Shot Plan par défaut.');
      return this.buildFromDefaults(shotCount);
    }

    const shots: Shot[] = [];
    for (let i = 0; i < shotCount; i++) {
      const candidate = parsed[i];
      shots.push(this.isValidShot(candidate) ? candidate : DEFAULT_SHOT_PLAN[i % DEFAULT_SHOT_PLAN.length]);
    }
    return shots;
  }

  private isValidShot(value: unknown): value is Shot {
    if (!value || typeof value !== 'object') return false;
    const shot = value as Record<string, unknown>;
    return ['camera', 'subject', 'motion', 'lighting', 'background'].every((key) => typeof shot[key] === 'string' && shot[key].length > 0);
  }

  private buildFromDefaults(shotCount: number): ShotPlan {
    return Array.from({ length: shotCount }, (_, i) => DEFAULT_SHOT_PLAN[i % DEFAULT_SHOT_PLAN.length]);
  }
}
