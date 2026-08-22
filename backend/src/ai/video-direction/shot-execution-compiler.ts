import { Shot } from './video-director.service';
import { ShotQualityResult } from './video-analyzer.service';
import { CreativeConcept } from '../creative-intelligence/creative-concept.types';
import { NarrativeBlueprint } from '../creative-intelligence/narrative-blueprint.types';

// Mission 4.3 — Goal-First Quality Architecture, Phase 4, Étape 6. Audit forensique : le Shot Plan
// demande 21 champs à l'IA (32 au total sur le type Shot) mais seuls 9 atteignaient jusqu'ici le
// prompt vidéo (serializeShotToPrompt, avant ce chantier) — 23 champs planifiés puis silencieusement
// jetés avant Veo. Ce compilateur est le point UNIQUE où un Shot planifié devient une instruction
// d'exécution vidéo réelle — fonction PURE, déterministe, aucun appel IA (même discipline que
// shot-plan-validator.ts).
//
// onScreenText/voiceover/soundDesign restent délibérément HORS PÉRIMÈTRE (cf. commentaire sur
// Shot dans video-director.service.ts) : ces champs ne sont jamais composités à l'image (Veo ne
// rend pas de texte de façon fiable) — ils servent d'intention planifiée au Video Judge et à la
// modération élargie, jamais d'instruction de génération. Les inclure ici contredirait ce choix
// de conception déjà établi.
export interface ShotExecutionContext {
  creativeConcept: CreativeConcept;
  narrativeBlueprint: NarrativeBlueprint;
}

export interface VideoGenerationInstruction {
  // Gabarit cinématographique 7 lignes + préfixe narrativeRole + lignes action/cameraMovement/
  // productBenefit déjà interleaved — repris VERBATIM de l'ancien VideoDirectorService.
  // serializeShotToPrompt (non-régression testée littéralement, cf. video-director.service.spec.ts)
  // — jamais réécrit, seulement relocalisé ici et étendu par les niveaux suivants.
  mustObey: string;
  primaryVisualExecution: string[];
  supportingDetails: string[];
  continuity: string[];
  negativeConstraints: string[];
  // mustObey + toutes les lignes non vides des niveaux suivants, dans cet ordre — c'est ce qui
  // atteint réellement le fournisseur vidéo. La hiérarchie MUST OBEY/PRIMARY/SUPPORTING/
  // CONTINUITY/NEGATIVE est exprimée par la FORME typée ci-dessus et par l'ORDRE de concaténation,
  // jamais par des en-têtes littéraux ("MUST OBEY:", etc.) injectés dans le prompt — Veo n'est pas
  // entraîné à les interpréter comme des sections, ce serait du bruit dans un prompt cinématographique.
  prompt: string;
}

export function compileShotExecutionInstruction(shot: Shot, context: ShotExecutionContext): VideoGenerationInstruction {
  const mustObey = buildMustObey(shot);

  const primaryVisualExecution = [
    shot.cameraShot?.trim() ? `Shot framing: ${shot.cameraShot}` : '',
    shot.productPresence?.trim() ? `Product presence: ${shot.productPresence}` : '',
    shot.proofElement?.trim() ? `Proof element to render visibly: ${shot.proofElement}` : '',
  ].filter(Boolean);

  const supportingDetails = [
    shot.location?.trim() ? `Setting: ${shot.location}` : '',
    shot.atmosphere?.trim() ? `Atmosphere: ${shot.atmosphere}` : '',
    shot.visualDetails?.trim() ? `Visual details: ${shot.visualDetails}` : '',
    shot.characters?.trim() ? `Characters/subjects present: ${shot.characters}` : '',
    context.creativeConcept.visualDirection?.trim() ? `Overall visual direction: ${context.creativeConcept.visualDirection}` : '',
    context.creativeConcept.emotionalDirection?.trim() ? `Emotional tone for this shot: ${context.creativeConcept.emotionalDirection}` : '',
  ].filter(Boolean);

  // Lien Shot -> beat narratif (Mission 4.3 Phase 4, Étape 5) — quand ce plan a été explicitement
  // rattaché à un beat du NarrativeBlueprint (narrativeBeatId, cf. VideoDirectorService.
  // generateShotPlan), la preuve visuelle attendue par CE beat devient une instruction concrète
  // pour CE plan précis — jamais un lien silencieux, jamais une erreur si le beat n'existe plus.
  const linkedBeat = shot.narrativeBeatId ? context.narrativeBlueprint.beats.find((b) => b.id === shot.narrativeBeatId) : undefined;
  const continuity = [
    shot.transition?.trim() ? `Transition intent: ${shot.transition}` : '',
    linkedBeat?.requiredVisualEvidence?.trim() ? `This shot must visually prove: ${linkedBeat.requiredVisualEvidence}` : '',
  ].filter(Boolean);

  // Base fixe, toujours présente — pas encore de source de données pour des contraintes négatives
  // dynamiques (ex. dérivées de shot.riskLevel) : plancher déterministe plutôt qu'inventé.
  const negativeConstraints = [
    'Avoid any static or frozen frame — motion must be continuous throughout.',
    'Never render on-screen text, logos, or brand marks that are not present in the reference image.',
  ];

  const prompt = [mustObey, ...primaryVisualExecution, ...supportingDetails, ...continuity, ...negativeConstraints]
    .filter((section) => section.trim().length > 0)
    .join('\n');

  return { mustObey, primaryVisualExecution, supportingDetails, continuity, negativeConstraints, prompt };
}

// Reproduit le gabarit cinématographique validé pour Veo — la structure et le wording de ces
// 7 lignes sont volontairement figés (non-régression testée), y compris la contrainte finale
// anti-plan-fixe. `subject` est intégré dans la ligne Camera (le gabarit n'a pas de ligne
// dédiée) plutôt que d'ajouter une 8e ligne — déviation assumée et signalée lors de la
// conception de cette architecture. Relocalisé tel quel depuis VideoDirectorService.
// serializeShotToPrompt (Mission 4.3 Phase 4) — aucune ligne de logique modifiée.
function buildMustObey(shot: Shot): string {
  const cameraLine = shot.subject && shot.subject.trim().toLowerCase() !== 'product' ? `${shot.camera} focused on the ${shot.subject}` : shot.camera;
  const narrativeContext = shot.narrativeRole ? `This shot is the "${shot.narrativeRole}" beat of the commercial.\n` : '';

  const actionLine = shot.action?.trim() ? `\nAction: ${shot.action}` : '';
  const cameraMovementLine = shot.cameraMovement?.trim() ? `\nCamera movement: ${shot.cameraMovement}` : '';
  const productBenefitLine = shot.productBenefit?.trim() ? `\nWhat this shot must convey: ${shot.productBenefit}` : '';

  return `${narrativeContext}Create a dynamic premium product commercial.
The product remains visually identical to the reference image.
Camera: ${cameraLine}
Motion: ${shot.motion}
Environment: ${shot.background}
Lighting: ${shot.lighting}${actionLine}${cameraMovementLine}${productBenefitLine}
The movement must remain continuous throughout the entire shot.
Avoid a static camera and avoid a still-image effect.`;
}

// Relocalisé depuis VideoDirectorService.repairShotPrompt (Mission 4.3 Phase 4) — même logique de
// cumul de correctifs, base désormais compileShotExecutionInstruction(...).prompt (identique au
// contenu produit par l'ancien serializeShotToPrompt(shot) pour un contexte donné).
export function compileShotRepairInstruction(
  shot: Shot,
  quality: ShotQualityResult,
  context: ShotExecutionContext,
  additionalDefect?: { type: 'transition'; description: string },
  escalation?: { priorFailureReason: string },
): string {
  const base = compileShotExecutionInstruction(shot, context).prompt;
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
  if (additionalDefect?.type === 'transition') {
    fixes.push(
      `IMPORTANT: ensure this shot's ending motion and framing transitions smoothly into the next shot's opening (${additionalDefect.description}) — avoid an abrupt cut in subject or camera angle.`,
    );
  }
  if (escalation) {
    fixes.push(
      `CRITICAL — a previous correction attempt for this exact issue (${escalation.priorFailureReason}) still failed to fix it sufficiently. This is your final attempt: make the fix unmistakably obvious and exaggerated rather than subtle.`,
    );
  }
  return fixes.length > 0 ? `${base}\n\n${fixes.join('\n')}` : base;
}
