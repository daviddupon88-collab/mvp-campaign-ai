import { PromptTask } from '../prompt-task.enum';
import { PromptTemplate } from '../prompt-engine.types';
import { CreativeIntelligence } from '../../creative-intelligence/creative-intelligence.types';
import { CreativeConcept } from '../../creative-intelligence/creative-concept.types';

export interface CreativeGateContext {
  creativeIntelligence: CreativeIntelligence;
  creativeConcept: CreativeConcept;
  objective: string;
  groundedContextBlock: string; // renderGroundedContext(profile), '' si aucun profil
  // Mission 4.3 (Goal-First Quality Architecture, Phase 1) — renderQualityRequirementsForPrompt(...),
  // '' si aucune exigence de construction applicable au stade concept.
  qualityRequirementsBlock: string;
}

// Template CREATIVE_GATE (Phase G, chantier "Moteur d'optimisation de la qualité vidéo — V2",
// 2026-08-19, spec Sections 35-45). Question centrale du spec : "si nous générions exactement
// cette vidéo, aurait-elle une vraie capacité à promouvoir le produit et à atteindre l'objectif
// de campagne ?" — jamais un jugement sur la qualité d'écriture seule.
export const creativeGateTemplate: PromptTemplate<CreativeGateContext> = {
  task: PromptTask.CREATIVE_GATE,
  role: 'Tu es un directeur de création publicitaire senior, qui valide un concept AVANT tout tournage — le budget de production dépend de ton jugement.',
  mission: "Juger si ce concept publicitaire constitue une PUBLICITÉ réellement exploitable, pas seulement une idée intéressante.",
  constraints: [
    'Sois strict : un motif de rejet automatique présent (produit mal intégré, bénéfice incompréhensible, aucun hook réel, aucun CTA alors que nécessaire, information inventée, irréalisable techniquement) impose BLOCKED même si le score serait par ailleurs élevé.',
    "Le hook générique (\"Découvrez notre nouveau produit\") sans justification particulière doit recevoir un score de hookStrength bas — il n'a aucune fonction publicitaire réelle.",
    'Ne juge que ce qui est présent dans le concept ci-dessous — ne suppose jamais une caractéristique produit non confirmée par le contexte fourni.',
  ],
  outputSchema: `{
  "score": 0-100,
  "verdict": "APPROVED"|"REVISE"|"BLOCKED",
  "hook": "...",
  "promessePrincipale": "...",
  "benefices": ["...", "..."],
  "preuve": "...",
  "cta": "...",
  "forces": ["...", "..."],
  "faiblesses": ["...", "..."],
  "risques": ["...", "..."],
  "causesDeRejet": ["..."],
  "recommandation": "..."
}`,
  evaluationCriteria: [
    'Pertinence produit (15)', 'Pertinence cible (15)', 'Force du hook (15)', 'Clarté du bénéfice (15)',
    'Potentiel publicitaire (15)', 'Storytelling potentiel (10)', 'Différenciation (5)', 'Cohérence marque (5)', 'CTA (5)',
    'JSON strictement valide',
  ],
  render(context: CreativeGateContext): string {
    return `${this.role} ${this.mission}

${this.constraints.join(' ')}

Objectif de campagne : ${context.objective}

Intelligence publicitaire :
${JSON.stringify(context.creativeIntelligence)}

Concept publicitaire proposé :
${JSON.stringify(context.creativeConcept)}${context.groundedContextBlock}${context.qualityRequirementsBlock}

Évalue sur les 9 dimensions pondérées (somme=100) : ${this.evaluationCriteria!.slice(0, 9).join(', ')}.

Réponds UNIQUEMENT en JSON strict, sans texte autour, au format exact :
${this.outputSchema}`;
  },
};
