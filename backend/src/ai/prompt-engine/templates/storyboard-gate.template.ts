import { PromptTask } from '../prompt-task.enum';
import { PromptTemplate } from '../prompt-engine.types';
import { CreativeConcept } from '../../creative-intelligence/creative-concept.types';
import { ShotPlan } from '../../video-direction/video-director.service';
import { STORYBOARD_STAGE_CRITERIA } from '../../quality/quality-requirements';

export interface StoryboardGateContext {
  creativeConcept: CreativeConcept;
  shotPlan: ShotPlan;
  // Mission 4.3 (Goal-First Quality Architecture, Phase 1) — renderQualityRequirementsForPrompt(...),
  // '' si aucune exigence de construction applicable au stade storyboard.
  qualityRequirementsBlock: string;
  // Mission 4.3 (Goal-First Quality Architecture, Phase 5b, Étape 8) — ce gate devient le
  // PreProductionQualityJudge : il voit désormais la structure narrative visée, ce que le
  // fournisseur vidéo recevra réellement, et le contexte produit vérifié.
  narrativeBlueprintBlock: string;
  executionInstructionsBlock: string;
  groundedContextBlock: string;
}

// Template STORYBOARD_GATE (Phase H, chantier "Moteur d'optimisation de la qualité vidéo — V2",
// 2026-08-19, spec Sections 46-53). UN SEUL appel groupé (même discipline de coût que le Video
// Judge) couvrant : fonction narrative de chaque plan + test de suppression + continuité N→N+1 +
// simulation de compréhension sans vidéo + test des 3 niveaux (hook / milieu / fin).
export const storyboardGateTemplate: PromptTemplate<StoryboardGateContext> = {
  task: PromptTask.STORYBOARD_GATE,
  role: "Tu es un réalisateur publicitaire senior qui valide un storyboard AVANT le tournage — chaque plan coûte cher à produire.",
  mission: 'Juger si ce storyboard, plan par plan, traduit réellement le concept en une publicité compréhensible et efficace.',
  constraints: [
    'Pour chaque plan, demande-toi : "si ce plan est supprimé, la publicité perd-elle quelque chose d\'important ?" — si non, ajoute son sceneId à scenesToRemove.',
    'Simule un spectateur qui ne connaît pas la marque : à la fin, doit-il pouvoir répondre à "quel produit ?", "à quoi sert-il ?", "quel bénéfice ?", "quelle action attendue ?" — si plusieurs réponses sont impossibles, REJECT.',
    'Vérifie la continuité entre chaque plan et le suivant (produit, sujet, espace, temps, lumière, émotion, récit, message) — une transition doit avoir une fonction, pas seulement être jolie.',
    'Ne recommande JAMAIS la suppression du seul plan portant le hook ou le seul plan portant le CTA, même si sa fonction narrative semble faible isolément.',
    "Juge les instructions d'exécution compilées ci-dessous (ce que le fournisseur vidéo recevra réellement), pas seulement le Shot Plan JSON — un plan JSON correct peut malgré tout produire une instruction d'exécution pauvre ou incohérente.",
    'Score explicitement chacun des critères listés ci-dessous dans criterionScores (0-100 chacun) — ne te contente pas d\'un score global.',
    "Si un défaut identifié ne peut pas être corrigé par une simple régénération du Shot Plan (ex. le concept lui-même est en cause, ou le produit n'est pas fidèlement représenté), indique-le dans rootCauseLevel plutôt que de suggérer une correction hors de portée.",
  ],
  outputSchema: `{
  "score": 0-100,
  "verdict": "APPROVED"|"REJECT",
  "scenesToRemove": ["sceneId", "..."],
  "faiblesses": ["...", "..."],
  "recommandation": "...",
  "criterionScores": { ${STORYBOARD_STAGE_CRITERIA.map((c) => `"${c}": 0-100`).join(', ')} },
  "risks": ["...", "..."],
  "requiredChanges": ["...", "..."],
  "rootCauseLevel": "SHOT"|"NARRATIVE"|"CONCEPT"|"PRODUCT"|"EXECUTION"|"BRAND"|"TECHNICAL"|null
}`,
  evaluationCriteria: [
    'Clarté narrative (15)', 'Présence et rôle du produit (15)', 'Communication du bénéfice (15)', 'Hook (15)',
    'Démonstration (10)', 'Progression narrative (10)', 'Mouvement prévu (5)', 'Continuité (5)', 'CTA (5)', 'Faisabilité technique (5)',
    'JSON strictement valide',
  ],
  render(context: StoryboardGateContext): string {
    return `${this.role} ${this.mission}

${this.constraints.join(' ')}

Concept publicitaire (le storyboard doit RACONTER cette idée précise) :
${JSON.stringify(context.creativeConcept)}

Storyboard proposé (${context.shotPlan.length} plans) :
${JSON.stringify(context.shotPlan)}${context.narrativeBlueprintBlock}${context.executionInstructionsBlock}${context.qualityRequirementsBlock}${context.groundedContextBlock}

Évalue sur les 10 dimensions pondérées (somme=100) : ${this.evaluationCriteria!.slice(0, 10).join(', ')}.

Réponds UNIQUEMENT en JSON strict, sans texte autour, au format exact :
${this.outputSchema}`;
  },
};
