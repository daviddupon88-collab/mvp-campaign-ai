import { PromptTask } from '../prompt-task.enum';
import { PromptTemplate } from '../prompt-engine.types';
import { CreativeConcept } from '../../creative-intelligence/creative-concept.types';

export interface NarrativeBlueprintContext {
  creativeConcept: CreativeConcept;
  // Mission 4.3 (Goal-First Quality Architecture, Phase 3) — buildStageQualityRequirementsBlock(...),
  // '' si aucune exigence de construction applicable au stade narratif (même stade que le concept :
  // hookStrength/ctaClarity/storytelling, cf. CONCEPT_STAGE_CRITERIA).
  qualityRequirementsBlock: string;
}

// Template NARRATIVE_BLUEPRINT (Mission 4.3, Phase 3, Étape 4). Transforme un Creative Concept
// déjà validé en une structure narrative beat par beat — la narration, le script de chaque canal
// et le rythme du Shot Plan en dérivent tous ENSUITE, aucun n'est plus reconstitué indépendamment
// (cf. brief : "Éviter que la voix-off soit générée comme un texte indépendant qui contredit le
// Creative Concept. Le script doit être construit POUR réaliser la structure narrative.").
export const narrativeBlueprintTemplate: PromptTemplate<NarrativeBlueprintContext> = {
  task: PromptTask.NARRATIVE_BLUEPRINT,
  role: 'Tu es un scénariste publicitaire senior, spécialiste de la structure narrative pour la vidéo publicitaire courte.',
  mission: "Transformer ce concept publicitaire déjà validé en une structure narrative précise, beat par beat — jamais une structure narrative générique déconnectée du concept fourni.",
  constraints: [
    'Chaque champ narratif (hook, problem, tension, reveal, productIntroduction, benefit, proof, emotionalPayoff, cta) doit être 1 à 2 phrases COURTES, dans la langue de la campagne, prêtes à être dites à voix haute — jamais une note de mise en scène ou une description visuelle.',
    'La progression doit suivre STRICTEMENT le hook/storytellingApproach/proofStrategy déjà déterminés par le concept — ne les ignore jamais pour repartir d\'une structure narrative générique.',
    'beats contient un beat par étape narrative RÉELLEMENT nécessaire (2 à 6) : chaque beat précise quel champ ci-dessus il réalise (role), son objectif, une durée indicative en secondes, la preuve visuelle attendue à l\'écran (requiredVisualEvidence) et le texte de voix off attendu (requiredVoiceover).',
    // Audit forensic (2026-08-22, campagnes réelles) : requiredVisualEvidence héritait de la
    // consigne "prêt à être dit à voix haute" de la contrainte ci-dessus (destinée aux 9 champs
    // narratifs top-level, PAS à requiredVisualEvidence) — résultat, des beats "proof" dont la
    // preuve visuelle attendue était en réalité une phrase à prononcer, jamais une action
    // filmable. Distinction rendue explicite : requiredVisualEvidence n'est JAMAIS une ligne de
    // voix off, toujours ce que la caméra doit littéralement montrer (même discipline SHOW > TELL
    // que proofToShow/proofStrategy en amont).
    'requiredVisualEvidence n\'est JAMAIS une phrase à prononcer (ça, c\'est le rôle de requiredVoiceover) — c\'est une action ou un état physiquement visible que la caméra doit montrer. MAUVAIS : "le produit est efficace". BON : "le tissu immergé dans le produit devient visiblement uniforme en quelques secondes". Un requiredVisualEvidence qui ne peut pas être filmé tel quel est invalide, même s\'il est vrai.',
    // Audit forensic (2026-08-22, campagne réelle) : 6 beats générés pour un Shot Plan de 3 plans
    // — chaque plan devait alors porter 2 preuves simultanées, rejeté par le Storyboard Gate pour
    // surcharge narrative. Chaque plan du Shot Plan ne pourra représenter concrètement qu'UN SEUL
    // beat (cf. shot-plan-v3, contrainte de fidélité action/proofElement au beat rattaché) —
    // générer plus de beats que de plans garantit donc soit des beats orphelins, soit des plans
    // surchargés à l'exécution.
    'Le nombre de beats ne doit JAMAIS dépasser scenesCount (le nombre de plans prévus pour ce concept, cf. ci-dessous) — chaque plan du Shot Plan ne pourra porter concrètement qu\'UN SEUL beat. Si le nombre d\'étapes narratives naturelles dépasse scenesCount, fusionne les étapes adjacentes les moins critiques en un seul beat plutôt que d\'en produire plus que de plans disponibles.',
    'pausePoints identifie 1 à 3 moments où la voix off doit marquer une respiration — jamais un débit ininterrompu du début à la fin.',
  ],
  outputSchema: `{
  "hook": "...", "problem": "...", "tension": "...", "reveal": "...", "productIntroduction": "...",
  "benefit": "...", "proof": "...", "emotionalPayoff": "...", "cta": "...",
  "pacing": "...",
  "pausePoints": ["...", "..."],
  "beats": [{"id": "beat-1", "role": "hook", "objective": "...", "duration": 3, "requiredVisualEvidence": "...", "requiredVoiceover": "..."}]
}`,
  evaluationCriteria: [
    'Fidélité au concept (hook/storytellingApproach/proofStrategy)', 'Progression narrative claire', 'Texte prêt à être dit à voix haute', 'JSON strictement valide',
  ],
  render(context: NarrativeBlueprintContext): string {
    return `${this.role} ${this.mission}

${this.constraints[0]}
${this.constraints[1]}

Concept publicitaire retenu (cette structure narrative doit RACONTER cette idée précise) :
${JSON.stringify(context.creativeConcept)}${context.qualityRequirementsBlock}

Nombre de plans prévus pour ce concept (scenesCount) : ${context.creativeConcept.scenesCount}.

${this.constraints[2]}
${this.constraints[3]}
${this.constraints[4]}
${this.constraints[5]}

Réponds UNIQUEMENT en JSON strict, sans texte autour, au format exact :
${this.outputSchema}`;
  },
};
