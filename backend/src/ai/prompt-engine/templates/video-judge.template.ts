import { PromptTask } from '../prompt-task.enum';
import { PromptTemplate } from '../prompt-engine.types';
import { CreativeConcept } from '../../creative-intelligence/creative-concept.types';

export interface VideoJudgeContext {
  concept: CreativeConcept;
  transcriptText: string; // segments transcrits joints, '' si aucun transcript disponible
  plannedOnScreenText: string; // Shot.onScreenText planifiés, joints
  groundedContextBlock: string; // renderGroundedContext(profile), '' si aucun profil
  // Mission 4.3 (Goal-First Quality Architecture, Phase 6c, Étape 10) — beats du NarrativeBlueprint
  // (id/role/requiredVisualEvidence/requiredVoiceover), rendu JSON. Jusqu'ici ce Judge ne voyait
  // que le CreativeConcept (un résumé) — jamais la structure narrative RÉELLEMENT planifiée que le
  // transcript/texte à l'écran étaient censés réaliser. Permet une vraie comparaison
  // attendu-vs-réel plutôt qu'un jugement esthétique sans référence.
  narrativeBlueprintBlock: string;
}

// Template VIDEO_JUDGE (P0.5, chantier "Creative Intelligence Engine & Video Quality Loop",
// 2026-08-18) — UN appel groupé pour les 9 critères qui exigent un jugement sémantique
// (les 6 autres critères des 15 demandés par le brief sont calculés en code, à coût nul, cf.
// VideoJudgeService : productConsistency/motionDynamism agrégés depuis les plans déjà notés,
// audioQuality/voiceAudibility mesurés par ffmpeg, formatCompliance déjà validé en amont par
// VideoQcService, productVisibility via un appel analyzeImage séparé sur la vidéo finale).
export const videoJudgeTemplate: PromptTemplate<VideoJudgeContext> = {
  task: PromptTask.VIDEO_JUDGE,
  role: 'Tu es un directeur de création publicitaire senior, qui évalue une publicité vidéo terminée avant sa mise en ligne.',
  mission: 'Juger objectivement 9 critères de qualité publicitaire à partir du concept prévu, du script réellement parlé (transcript) et du texte à l\'écran planifié — jamais complaisant.',
  constraints: [
    "Pour \"factualConsistency\" : compare le transcript/texte à l'écran UNIQUEMENT au bloc d'intelligence produit ci-dessous — toute affirmation absente de ce bloc ou marquée non vérifiée qui serait présentée comme un fait acquis dans le transcript est un défaut grave (score bas).",
    "Un critère non évaluable par manque de données (ex: pas de transcript disponible) reçoit un score neutre (50) avec le défaut \"Vérification indisponible\", jamais un score inventé.",
    'sceneRef (optionnel) référence un sceneId du concept quand le défaut est attribuable à un moment précis, sinon omets ce champ.',
    "Pour \"advertisingEffectiveness\" : ne juge JAMAIS la seule qualité esthétique — la question est \"cette vidéo donnerait-elle réellement envie à la cible d'agir (cliquer, acheter, s'inscrire) ?\". Une vidéo magnifique mais qui ne persuade pas doit recevoir un score bas sur ce critère précis, même si les autres critères sont excellents.",
    // Mission 4.3 (Goal-First Quality Architecture, Phase 6c, Étape 10) — comparaison ATTENDU vs
    // RÉEL, pas un jugement esthétique isolé : chaque beat ci-dessous fixait un requiredVoiceover
    // (ce que la voix off devait dire) et un requiredVisualEvidence (ce que le plan devait montrer).
    'Pour "storytelling"/"hookStrength"/"ctaClarity" : compare le transcript RÉEL au requiredVoiceover attendu de chaque beat du NarrativeBlueprint ci-dessous — un beat dont le contenu attendu est absent ou trahi dans le transcript réel est un défaut concret et attribuable (cite le beat concerné dans justification), pas une impression générale.',
  ],
  outputSchema: `[{"name":"storytelling"|"hookStrength"|"pacing"|"textReadability"|"grammar"|"ctaClarity"|"brandCoherence"|"factualConsistency"|"advertisingEffectiveness","score":0-100,"justification":"...","defect":"..."|null,"sceneRef":"..."|null}]`,
  evaluationCriteria: ['EXACTEMENT 9 entrées, une par critère listé', 'factualConsistency ne tolère aucune invention', 'JSON strictement valide'],
  render(context: VideoJudgeContext): string {
    const transcriptBlock = context.transcriptText.trim() ? `\nTranscript réel de la narration : ${context.transcriptText}` : '\nAucun transcript disponible (narration non générée ou échec de transcription).';
    const onScreenBlock = context.plannedOnScreenText.trim() ? `\nTexte à l'écran planifié : ${context.plannedOnScreenText}` : '';

    return `${this.role} ${this.mission}

Concept publicitaire prévu :
${JSON.stringify(context.concept)}

Structure narrative attendue (beats planifiés — chacun fixe ce que la voix off/le plan devaient réaliser) :
${context.narrativeBlueprintBlock}${transcriptBlock}${onScreenBlock}${context.groundedContextBlock}

${this.constraints.join(' ')}

Réponds UNIQUEMENT en JSON strict, sans texte autour, un tableau d'EXACTEMENT 9 objets au format exact :
${this.outputSchema}`;
  },
};
