import { Injectable, Logger } from '@nestjs/common';
import { parseAiJson } from '../../common/parsing/parse-ai-json';
import { AiGatewayService, AiCallContext } from '../ai-gateway/ai-gateway.service';
import { VisualDna } from './visual-dna.service';
import { ShotQualityResult } from './video-analyzer.service';
import { PROMPT_VERSIONS } from '../prompt-versions';
import { CreativeConcept } from '../creative-intelligence/creative-concept.types';
import { NarrativeBeat, NarrativeBlueprint } from '../creative-intelligence/narrative-blueprint.types';
import { compileShotExecutionInstruction, compileShotRepairInstruction, ShotExecutionContext } from './shot-execution-compiler';

// Un plan (shot) de la vidéo finale — direction artistique structurée, jamais un simple prompt
// texte libre. C'est ce qui sépare la RÉFLEXION créative (cette structure) de l'EXÉCUTION (Veo,
// qui ne fait plus qu'exécuter un plan déjà décidé) — cf. le constat qui a motivé toute cette
// architecture : un prompt texte unique demandait à Veo de comprendre le produit, inventer le
// scénario ET cadrer/filmer en même temps, ce qui produisait un résultat générique et statique.
//
// Champs enrichis (chantier "Creative Intelligence Engine & Video Quality Loop", 2026-08-18) :
// "Scene" et "Shot" restent le MÊME concept dans ce code (décision de périmètre explicite, cf.
// plan) — un Shot EST une scène, juste avec un vocabulaire de tournage plutôt que de montage.
// Tous nouveaux champs optionnels sauf sceneId (additif — DEFAULT_SHOT_PLAN et les Shot
// littéraux déjà testés ailleurs restent valides sans eux).
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
  // Mission 4.3 (Goal-First Quality Architecture, Phase 4, Étape 5) — référence l'id d'un
  // NarrativeBlueprint.beats[] (cf. narrative-blueprint.types.ts), demandé au LLM au même titre
  // que narrativeRole. Contrairement à narrativeRole (texte libre), permet un lien STRUCTURÉ vers
  // la preuve visuelle attendue par ce beat précis (cf. ShotExecutionCompiler) et le regroupement
  // déterministe shot->beat (cf. linkBeatsToShots ci-dessous). Optionnel/additif : absent = plan
  // non rattaché à un beat précis (jamais une erreur).
  narrativeBeatId?: string;
  // Identifiant stable de CE plan — TOUJOURS assigné déterministiquement en code (`shot-${i+1}`),
  // JAMAIS confié au LLM (cf. tryParseShotPlan) : c'est la clé utilisée par le Video Judge, le
  // Repair Dispatch et la trace d'observabilité pour référencer "quel plan précisément".
  sceneId: string;
  startTime?: number;
  endTime?: number;
  duration?: number;
  objective?: string;
  location?: string;
  characters?: string;
  productPresence?: string;
  action?: string;
  cameraShot?: string; // taille/cadrage du plan (ex: "close-up") — distinct de `camera` (mouvement)
  cameraMovement?: string;
  atmosphere?: string;
  visualDetails?: string;
  transition?: string;
  // Ni l'un ni l'autre n'est composité à l'image (hors périmètre de ce chantier, cf. plan) —
  // utilisés comme intention planifiée par le Video Judge et la modération élargie (P0.5/P0.10).
  onScreenText?: string;
  voiceover?: string;
  soundDesign?: string;
  productBenefit?: string;
  proofElement?: string;
  // Phase N (chantier "Optimisation du pipeline vidéo — V2.1", 2026-08-19, spec Section 12-13) :
  // contrat de scène enrichi. Tous optionnels et renseignés en SORTIE du pipeline (post-parsing/
  // post-génération) — jamais demandés au LLM en entrée, isShotStructurallyValid() ci-dessous
  // reste inchangé et n'exige toujours que les 5 champs de base.
  dependencies?: string[]; // sceneId dont ce plan dépend — absent/vide = indépendant (Phase M)
  priority?: 'P0' | 'P1' | 'P2' | 'P3';
  riskLevel?: import('./shot-risk').SceneRisk;
  generationStatus?: 'PENDING' | 'GENERATING' | 'SUCCEEDED' | 'FAILED';
  validationStatus?: 'PENDING' | 'PASSED' | 'INVALID';
  qualityScore?: number;
  // Audit forensique Mission 4.2 (P0-2) : true quand CE plan précis est une substitution
  // DEFAULT_SHOT_PLAN[i % 3] (entrée individuellement malformée au sein d'une réponse par
  // ailleurs exploitable, cf. tryParseShotPlan) — sans ce flag, un plan générique sans rapport
  // avec le concept passe la validation structurelle et atteint la génération vidéo (150
  // crédits) sans que rien ne le signale. Optionnel/additif, absent = plan réellement généré.
  usedFallbackTemplate?: boolean;
}
export type ShotPlan = Shot[];

// Exportée (Phase E, chantier "Moteur d'optimisation de la qualité vidéo — V2") pour être
// réutilisée par shot-plan-validator.ts SANS dupliquer cette définition — une seule source de
// vérité sur ce qui constitue un plan "structurellement valide", que ce soit pendant le parsing
// de la réponse LLM (usage historique) ou pendant la validation pré-génération (nouvel usage).
export function isShotStructurallyValid(value: unknown): value is Shot {
  if (!value || typeof value !== 'object') return false;
  const shot = value as Record<string, unknown>;
  return ['camera', 'subject', 'motion', 'lighting', 'background'].every((key) => typeof shot[key] === 'string' && shot[key].length > 0);
}

export interface GenerateShotPlanParams {
  visualDna: VisualDna;
  productDescription: string;
  objective: string; // objectif de campagne — champ dédié plutôt que noyé dans campaignContext, pour rester explicite même si la stratégie est longue (chantier "prompts précis, orientés objectif" du 2026-08-18)
  campaignContext: string; // texte de stratégie déjà généré — ancre le Shot Plan dans l'angle marketing retenu, pas une improvisation déconnectée
  // Mission 4.3 (Goal-First Quality Architecture, Phase 3) — remplace l'ancien narrationHint (texte
  // plat) : la structure narrative complète (beats, pacing) aide au rythme/nombre de plans, jamais
  // lue telle quelle par Veo. Toujours disponible (calculé avant le Shot Plan dans tous les
  // chemins d'appel), donc obligatoire — jamais optionnel comme l'ancien narrationHint.
  narrativeBlueprint: NarrativeBlueprint;
  // NOUVEAU (P0.3) : le Shot Plan est désormais ANCRÉ sur une vraie idée publicitaire plutôt que
  // généré depuis des paramètres bruts — pilote aussi shotCount (scenesCount du concept).
  creativeConcept: CreativeConcept;
  // NOUVEAU (P0.4) : liste de combinaisons caméra/action à éviter, injectée uniquement lors
  // d'une régénération déclenchée par detectShotRepetition() — absent en temps normal.
  avoidRepetitionHint?: string;
  // Phase H (chantier V2, 2026-08-19) : injecté uniquement lors de l'unique régénération
  // déclenchée par un verdict REJECT/score<75 du Storyboard Gate — absent en temps normal.
  storyboardGateFeedback?: string;
}

// Comblement PARTIEL uniquement (une entrée individuellement malformée au sein d'une réponse par
// ailleurs exploitable, cf. tryParseShotPlan) — l'exemple concret donné lors de la conception de
// cette architecture : un travelling avant avec rotation lente, une orbite à 45° qui poursuit la
// rotation, un plan serré sur le logo. Un vrai repli délibéré, pas un placeholder vide. N'est
// PLUS utilisé comme repli TOTAL (Shot Plan entièrement générique) — cf. generateShotPlanWithRetry,
// qui échoue franchement plutôt que de substituer un plan sans rapport avec le concept.
// sceneId ci-dessous est indicatif (recalculé par index dans tryParseShotPlan de toute façon) —
// présent pour que ce tableau reste un ShotPlan valide utilisé isolément.
export const DEFAULT_SHOT_PLAN: ShotPlan = [
  {
    sceneId: 'shot-1',
    camera: 'slow cinematic push-in',
    subject: 'product',
    motion: 'the product rotates slowly',
    lighting: 'a moving highlight sweeps across the product',
    background: 'subtle floating particles move through the scene',
    narrativeRole: 'hook',
  },
  {
    sceneId: 'shot-2',
    camera: 'smooth 45-degree orbit',
    subject: 'product',
    motion: 'rotation continues at a steady pace',
    lighting: 'a stronger light sweep travels from left to right',
    background: 'subtle floating particles move through the scene',
    narrativeRole: 'demonstration',
  },
  {
    sceneId: 'shot-3',
    camera: 'close-up',
    subject: 'logo',
    motion: 'slight push-in',
    lighting: 'a focused highlight on the logo',
    background: 'softly blurred product surface',
    narrativeRole: 'payoff',
  },
];

// Video Director : transforme l'ADN visuel + le concept créatif en un Shot Plan structuré (un
// raisonnement créatif, pas une génération vidéo) — Veo (ou tout autre fournisseur vidéo) ne
// fait plus qu'exécuter chaque plan déjà décidé ici, cf. AiOrchestratorService qui consomme ce
// Shot Plan un plan à la fois.
@Injectable()
export class VideoDirectorService {
  private readonly logger = new Logger(VideoDirectorService.name);

  constructor(private readonly aiGateway: AiGatewayService) {}

  async generateShotPlan(ctx: AiCallContext, params: GenerateShotPlanParams): Promise<ShotPlan> {
    const shotCount = params.creativeConcept.scenesCount;
    const bp = params.narrativeBlueprint;
    const narrationBlock = `\nStructure narrative prévue (pour caler le rythme et la progression des plans, ne pas la réciter) : Hook: ${bp.hook} | Problème: ${bp.problem} | Tension: ${bp.tension} | Révélation: ${bp.reveal} | Bénéfice: ${bp.benefit} | Preuve: ${bp.proof} | CTA: ${bp.cta}. Rythme voulu : ${bp.pacing}`;
    // Mission 4.3 (Goal-First Quality Architecture, Phase 4, Étape 5) — rattache chaque plan à un
    // beat narratif STRUCTURÉ (narrativeBeatId), pas seulement au libellé libre narrativeRole :
    // permet à ShotExecutionCompiler d'injecter la preuve visuelle attendue par ce beat précis
    // dans le prompt d'exécution de CE plan, et à linkBeatsToShots de peupler beats[].shotIds.
    const beatsBlock = bp.beats.length > 0
      ? `\nBeats narratifs disponibles (rattache CHAQUE plan à l'un de ces ids via narrativeBeatId) :\n${bp.beats.map((b) => `- ${b.id} (${b.role}) : ${b.requiredVisualEvidence}`).join('\n')}`
      : '';
    const conceptBlock = `\nConcept publicitaire retenu (le Shot Plan doit RACONTER cette idée précise, pas une idée générique) :
Titre : ${params.creativeConcept.title}
Idée : ${params.creativeConcept.concept}
Hook : ${params.creativeConcept.hook}
Approche narrative : ${params.creativeConcept.storytellingApproach}
Stratégie de preuve (ce qu'il faut MONTRER) : ${params.creativeConcept.proofStrategy}`;
    const avoidBlock = params.avoidRepetitionHint ? `\nIMPORTANT — le plan précédent manquait de diversité visuelle : ${params.avoidRepetitionHint}` : '';
    const storyboardGateBlock = params.storyboardGateFeedback ? `\nIMPORTANT — le storyboard précédent a été jugé insuffisant par le Storyboard Gate : ${params.storyboardGateFeedback}` : '';

    const prompt = `Tu es le réalisateur d'une publicité produit courte et dynamique. Voici l'identité visuelle du produit (à préserver dans chaque plan) :
${JSON.stringify(params.visualDna)}

Objectif de la campagne : ${params.objective}
Description produit : ${params.productDescription}
Contexte de campagne : ${params.campaignContext}${narrationBlock}${beatsBlock}${conceptBlock}${avoidBlock}${storyboardGateBlock}

Avant de concevoir les plans, détermine un arc narratif court en ${shotCount} temps (ex: accroche, démonstration du bénéfice, conclusion/rappel de marque) — les plans ne doivent JAMAIS être des angles esthétiques interchangeables sans lien entre eux, mais une progression qui se répond d'un plan à l'autre.
Conçois exactement ${shotCount} plans qui, mis bout à bout, forment une publicité premium dynamique — jamais un plan fixe, toujours un mouvement de caméra continu. Chaque plan doit avoir une raison d'exister : évite deux plans avec le même cadrage (cameraShot), le même mouvement de caméra (cameraMovement) et la même action.
Toute affirmation portée par onScreenText/voiceover DOIT être visuellement démontrée par les champs action/visualDetails/proofElement de CE MÊME plan — ne laisse JAMAIS la voix-off ou le texte à l'écran porter seuls une preuve, un lien de cause à effet ou une transformation que l'image ne montre pas explicitement (ex: si la voix-off affirme "plongé dans le produit", le champ action doit montrer littéralement l'immersion du produit/tissu, pas un geste générique à proximité).
Quand un plan est rattaché à un beat via narrativeBeatId, son champ action ou proofElement doit représenter concrètement la preuve visuelle attendue par ce beat (cf. "Beats narratifs disponibles" ci-dessus), pas seulement y faire allusion.
Chaque élément distinctif confirmé de l'ADN visuel (distinctiveFeatures) doit apparaître explicitement dans productPresence ou visualDetails d'AU MOINS un plan — ne l'omets jamais silencieusement.
"proofElement" (règle SHOW > TELL, comme proofStrategy/requiredVisualEvidence en amont) décrit l'action ou l'état PHYSIQUEMENT VISIBLE qui constitue la preuve de ce plan — jamais une affirmation. MAUVAIS : "le produit fonctionne bien". BON : "la mousse se dissout complètement en surface en 3 secondes". Laisse-le vide ("") si ce plan ne porte aucune preuve, n'invente jamais une preuve non filmable pour combler le champ.
Réponds UNIQUEMENT en JSON strict, sans texte autour : un tableau d'EXACTEMENT ${shotCount} objets, au format :
[{"camera":"...","subject":"...","motion":"...","lighting":"...","background":"...","narrativeRole":"...","narrativeBeatId":"...","objective":"...","location":"...","characters":"...","productPresence":"...","action":"...","cameraShot":"...","cameraMovement":"...","atmosphere":"...","visualDetails":"...","transition":"...","onScreenText":"...","voiceover":"...","soundDesign":"...","productBenefit":"...","proofElement":"..."}]
"narrativeRole" décrit en quelques mots le rôle narratif de CE plan précis dans l'arc (ex: "hook", "demonstration of the benefit", "payoff / brand recall"). "narrativeBeatId" reprend TEL QUEL l'un des ids listés plus haut (Beats narratifs disponibles) — laisse-le vide ("") si aucun beat ne correspond, n'invente jamais un id. "onScreenText"/"voiceover" sont de courtes phrases (pas des paragraphes) — laisse-les vides ("") si ce plan n'en a pas besoin, n'invente jamais un texte pour combler le champ.
Les valeurs des champs doivent être en anglais (langage cinématographique standard), sauf onScreenText/voiceover qui restent dans la langue de la campagne.`;

    return this.generateShotPlanWithRetry(ctx, prompt, shotCount);
  }

  // Audit forensic (2026-08-20, campagne réelle a294054e-9e0c-4569-813f-6114ea256f2f) : le JSON
  // du Shot Plan (21 champs × plusieurs plans, verbeux) s'est tronqué DEUX FOIS de suite en
  // conditions réelles ("Unterminated string in JSON"), et le code retombait silencieusement sur
  // DEFAULT_SHOT_PLAN — un plan générique "beauty shot produit" sans AUCUN rapport avec le
  // concept, qui a ensuite fait rejeter la campagne par le Storyboard Gate. Principe explicite de
  // l'utilisateur : "un échec de génération du Shot Plan ne doit JAMAIS être transformé en Shot
  // Plan générique susceptible de produire une campagne sans rapport avec le concept." Deux
  // corrections : (1) SHOT_PLAN_MAX_TOKENS plus généreux que le défaut de 4000 (cf.
  // AnthropicProvider.generateText — le thinking adaptatif de claude-sonnet-5 partage le même
  // budget que max_tokens, déjà identifié comme insuffisant pour ce prompt précis dans le
  // commentaire de ce provider) ; (2) UNE tentative de plus avant d'échouer franchement (même
  // discipline que VideoJudgeService.callTextCriteriaOnce, Mission 3) — jamais de repli générique
  // silencieux sur l'échec final : ÉCHEC EXPLICITE, propagé tel quel (pas préfixé "QUALITY_GATE:"
  // — un JSON tronqué 2 fois de suite est plus proche d'une panne fournisseur transitoire qu'un
  // rejet métier définitif, laisse BullMQ retenter le job complet en production).
  private static readonly SHOT_PLAN_MAX_TOKENS = 8000;

  private async generateShotPlanWithRetry(ctx: AiCallContext, prompt: string, shotCount: number): Promise<ShotPlan> {
    const first = await this.aiGateway.generateText(ctx, { prompt, maxTokens: VideoDirectorService.SHOT_PLAN_MAX_TOKENS }, 'anthropic', PROMPT_VERSIONS.shotPlan);
    const parsed = this.tryParseShotPlan(first.content, shotCount);
    if (parsed) return parsed;

    this.logger.warn('Shot Plan non exploitable au 1er essai — nouvelle tentative avant échec franc (jamais un repli générique silencieux).');
    const retry = await this.aiGateway.generateText(ctx, { prompt, maxTokens: VideoDirectorService.SHOT_PLAN_MAX_TOKENS }, 'anthropic', PROMPT_VERSIONS.shotPlan);
    const retryParsed = this.tryParseShotPlan(retry.content, shotCount);
    if (retryParsed) return retryParsed;

    throw new Error(
      'SHOT_PLAN_GENERATION_FAILED: impossible de générer un plan de tournage exploitable après 2 tentatives — jamais remplacé par un plan générique qui produirait une campagne sans rapport avec le concept.',
    );
  }

  // Mission 4.3 (Goal-First Quality Architecture, Phase 4, Étape 6) — délègue à
  // ShotExecutionCompiler (shot-execution-compiler.ts), qui centralise désormais la construction
  // du prompt d'exécution (gabarit historique + niveaux PRIMARY/SUPPORTING/CONTINUITY/NEGATIVE,
  // cf. son commentaire d'en-tête pour l'audit complet). Signature inchangée pour
  // AiOrchestratorService/VideoQualityLoopService à l'exception du nouveau `context` requis —
  // comportement identique à l'ancien serializeShotToPrompt(shot) pour un `context` neutre.
  serializeShotToPrompt(shot: Shot, context: ShotExecutionContext): string {
    return compileShotExecutionInstruction(shot, context).prompt;
  }

  // Repair Loop intelligent (chantier du 2026-08-18) : avant ce chantier, une régénération sur
  // échec qualité renvoyait EXACTEMENT le même prompt à Veo — un pur tirage aléatoire, aucun
  // diagnostic. VideoAnalyzerService calcule déjà PRÉCISÉMENT pourquoi un plan a échoué
  // (mouvement insuffisant et/ou produit méconnaissable) — ce diagnostic n'était jusqu'ici
  // jamais réinjecté dans la régénération. Construction de texte pure, AUCUN appel IA
  // supplémentaire : réutilise le budget de régénération déjà existant (2 essais/plan), juste
  // un prompt différent et ciblé au 2e essai.
  //
  // additionalDefect (P0.6, chantier Creative Intelligence) : branche "transition" — un défaut
  // de raccord détecté par le Video Judge sur la vidéo finale assemblée, attribué à CE plan
  // précis (celui dont la fin ne raccorde pas avec le plan suivant), distinct des défauts
  // mouvement/fidélité déjà détectés PENDANT la génération de ce même plan.
  // escalation (Phase B, chantier V2, 2026-08-19) : présent uniquement quand l'historique anti-
  // boucle (repair-history.ts) montre qu'une correction précédente sur EXACTEMENT ce défaut a eu
  // un résultat FAIBLE (progrès insuffisant, spec Section 4) — jamais un simple renvoi du même
  // texte de correction, un correctif plus radical/exagéré est demandé.
  // Mission 4.3 (Goal-First Quality Architecture, Phase 4, Étape 6) — délègue à
  // ShotExecutionCompiler.compileShotRepairInstruction, base désormais
  // compileShotExecutionInstruction(shot, context).prompt (identique au comportement historique).
  // `context` inséré comme 3e paramètre, après `quality` — tous les sites d'appel réels
  // (AiOrchestratorService, VideoQualityLoopService) ont déjà `quality` juste avant.
  repairShotPrompt(
    shot: Shot,
    quality: ShotQualityResult,
    context: ShotExecutionContext,
    additionalDefect?: { type: 'transition'; description: string },
    escalation?: { priorFailureReason: string },
  ): string {
    return compileShotRepairInstruction(shot, quality, context, additionalDefect, escalation);
  }

  // Parsing défensif suivant le même pattern que ModerationService.checkMisleadingClaimsBatch /
  // BrandConsistencyService.scoreTextBatch (réponse en tableau JSON, un modèle qui n'obéit pas
  // exactement au nombre demandé ne doit jamais faire échouer la génération vidéo pour UNE
  // entrée isolée malformée) : complète les entrées manquantes/malformées INDIVIDUELLEMENT depuis
  // DEFAULT_SHOT_PLAN (en bouclant dessus si shotCount > longueur du repli) — un plan par
  // ailleurs valide et spécifique au concept ne doit pas être jeté pour un seul champ glitché.
  // sceneId TOUJOURS réassigné déterministiquement par index ici — jamais celui (le cas échéant)
  // renvoyé par le modèle.
  //
  // Distinct de l'ÉCHEC TOTAL (JSON illisible ou pas un tableau du tout) : celui-ci ne retombe
  // PLUS sur un Shot Plan générique intégral (retourne `null`, cf. generateShotPlanWithRetry
  // ci-dessus) — un plan ENTIÈREMENT générique n'a structurellement aucun rapport avec le
  // concept, contrairement à un unique plan comblé au sein d'une réponse par ailleurs exploitable.
  private tryParseShotPlan(raw: string, shotCount: number): ShotPlan | null {
    let parsed: unknown;
    try {
      parsed = parseAiJson<any>(raw);
    } catch (error) {
      this.logger.warn(`Réponse du Video Director non conforme au format JSON attendu: ${error}`);
      return null;
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      this.logger.warn('Réponse du Video Director : JSON valide mais pas un tableau exploitable.');
      return null;
    }

    const shots: Shot[] = [];
    for (let i = 0; i < shotCount; i++) {
      const candidate = parsed[i];
      const valid = this.isValidShot(candidate);
      const base = valid ? candidate : DEFAULT_SHOT_PLAN[i % DEFAULT_SHOT_PLAN.length];
      shots.push({ ...base, sceneId: `shot-${i + 1}`, ...(valid ? {} : { usedFallbackTemplate: true }) });
    }
    return shots;
  }

  private isValidShot(value: unknown): value is Shot {
    return isShotStructurallyValid(value);
  }
}

// Mission 4.3 (Goal-First Quality Architecture, Phase 4, Étape 5) — regroupe les shots par
// narrativeBeatId et renvoie un NarrativeBlueprint dont beats[].shotIds reflète RÉELLEMENT le
// Shot Plan final (le champ existe depuis la Phase 3 mais restait toujours [], les shots
// n'existant pas encore au moment où le blueprint est généré). Fonction PURE, déterministe,
// aucun appel IA — jamais d'erreur si un shot référence un narrativeBeatId inconnu (ignoré
// silencieusement, jamais une raison de faire échouer une campagne pour un lien narratif
// approximatif) ni si aucun shot ne référence un beat donné (shotIds reste [] pour ce beat).
export function linkBeatsToShots(shotPlan: ShotPlan, blueprint: NarrativeBlueprint): NarrativeBlueprint {
  const shotIdsByBeatId = new Map<string, string[]>();
  for (const shot of shotPlan) {
    if (!shot.narrativeBeatId) continue;
    const existing = shotIdsByBeatId.get(shot.narrativeBeatId) ?? [];
    existing.push(shot.sceneId);
    shotIdsByBeatId.set(shot.narrativeBeatId, existing);
  }

  const beats: NarrativeBeat[] = blueprint.beats.map((beat) => ({ ...beat, shotIds: shotIdsByBeatId.get(beat.id) ?? [] }));
  return { ...blueprint, beats };
}
