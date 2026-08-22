import { NarrativeBlueprint } from './narrative-blueprint.types';
import { isLegacyNarrationExperimentMode } from './narration-experiment-flag';

// Mission 4.3 — Goal-First Quality Architecture, Phase 3. Fonction PURE, déterministe (aucun
// appel IA — même discipline que quality-requirements.ts), qui remplace les anciennes
// AiOrchestratorService.scriptToNarration()/buildFallbackNarration() : la narration dérive
// désormais TOUJOURS du NarrativeBlueprint, jamais reconstituée par regex depuis un script de
// canal (TikTok) généré indépendamment — élimine l'asymétrie documentée (campagnes sans TikTok
// recevant une narration bien plus pauvre que celles avec TikTok, cf. commentaire historique
// d'AiOrchestratorService avant ce chantier).
const MAX_NARRATION_CHARS = 400;

// Mission 4.6 (Narrative Execution Integrity, Phase 0 — audit à preuve) — ordre RENDU (arc
// narratif classique), distinct de l'ordre de SÉLECTION ci-dessous. Une fois qu'on sait QUELS
// champs entrent dans le budget, ils sont assemblés dans CET ordre pour rester cohérents.
const MIDDLE_FIELDS_NARRATIVE_ORDER = ['problem', 'tension', 'reveal', 'productIntroduction', 'benefit', 'proof', 'emotionalPayoff'] as const;

// Ordre de SÉLECTION sous contrainte de budget — PAR IMPORTANCE (mission 4.6, Phase 7 :
// benefit/proof = HIGH), jamais par position dans l'arc narratif. Preuve directe (comparaison du
// texte réellement envoyé à generateAudio vs creativeConcept.storytellingApproach sur B2/B5,
// campagnes réelles 2026-08-22) : l'ancien ordre de remplissage — narratif fixe — faisait de
// benefit/proof (5e/6e position sur 7) les premières victimes structurelles dès que
// problem/tension/reveal/productIntroduction remplissaient déjà le budget (~350/400 caractères
// en pratique). Même classe de bug que le cta en Mission 4.5, corrigée ici pour benefit/proof :
// on choisit QUI entre dans le budget par importance, puis on rend dans l'ordre narratif.
const MIDDLE_FIELDS_PRIORITY_ORDER = ['benefit', 'proof', 'problem', 'tension', 'reveal', 'productIntroduction', 'emotionalPayoff'] as const;

export function buildNarrationFromBlueprint(blueprint: NarrativeBlueprint, productDescriptionFallback: string): string {
  const hook = blueprint.hook?.trim();
  const cta = blueprint.cta?.trim();
  const middleFieldMap: Record<(typeof MIDDLE_FIELDS_NARRATIVE_ORDER)[number], string | undefined> = {
    problem: blueprint.problem?.trim(),
    tension: blueprint.tension?.trim(),
    reveal: blueprint.reveal?.trim(),
    productIntroduction: blueprint.productIntroduction?.trim(),
    benefit: blueprint.benefit?.trim(),
    proof: blueprint.proof?.trim(),
    emotionalPayoff: blueprint.emotionalPayoff?.trim(),
  };
  const middleParts = MIDDLE_FIELDS_NARRATIVE_ORDER.map((k) => middleFieldMap[k]).filter((s): s is string => !!s);

  // Mission 4.5 (Phases A2-A5, contrôles expérimentaux) — rejoue VOLONTAIREMENT le comportement
  // pré-correctif (troncature aveugle, cta potentiellement perdu) pour permettre une comparaison
  // A/B appariée avec le correctif déjà permanent ci-dessous. Jamais actif hors de cette
  // expérimentation (flag désactivé par défaut) — cf. narration-experiment-flag.ts.
  if (isLegacyNarrationExperimentMode()) {
    const legacyParts = [hook, ...middleParts, cta].filter((s): s is string => !!s);
    if (legacyParts.length > 0) return truncateJoined(legacyParts);
  }

  const anchors = [hook, cta].filter((s): s is string => !!s);
  if (anchors.length === 0 && middleParts.length === 0) {
    // Repli ultime (blueprint vide — échec de parsing IA, cf. NarrativeBlueprintService, jamais un
    // throw) — comportement historique inchangé, identique à l'ancien buildFallbackNarration.
    const category = /^Catégorie détectée\s*:\s*(.+)$/m.exec(productDescriptionFallback)?.[1]?.trim();
    const usp = /^USP\s*:\s*(.+)$/m.exec(productDescriptionFallback)?.[1]?.trim();
    if (category && usp && category !== 'non déterminée' && usp !== 'non déterminée') {
      return `Découvrez notre ${category} : ${truncateForNarration(usp, 100)}.`;
    }
    return `Découvrez ${truncateForNarration(productDescriptionFallback)}.`;
  }

  const anchorsLength = anchors.join('. ').length;

  // Cas pathologique (hook et/ou cta, À EUX SEULS, dépassent déjà le budget) : comportement
  // historique inchangé, troncature brute avec ellipse sur l'ensemble — n'arrive jamais en
  // pratique (hook/cta réels sont des phrases courtes), mais garde un repli sûr.
  if (anchorsLength >= MAX_NARRATION_CHARS) {
    return truncateJoined([hook, ...middleParts, cta].filter((s): s is string => !!s));
  }

  // Correction ciblée (Mission 4.5, Contrôle A1, campagne réelle 2026-08-22) — hook et cta sont
  // désormais TOUJOURS préservés intégralement : ce sont les deux ancrages qui portent
  // hookStrength/ctaClarity (critères CRITIQUES, cf. QualityTarget.criticalCriteria). L'ancienne
  // troncature aveugle à MAX_NARRATION_CHARS coupait le concat dans l'ORDRE (hook…cta EN
  // DERNIER), donc le cta était systématiquement la première victime dès que le contenu du
  // milieu (problem/tension/reveal/productIntroduction/benefit/proof/emotionalPayoff) rendait le
  // total trop long — observé en conditions réelles : CTA vocal jamais prononcé, narration
  // terminée sur un mot tronqué incompréhensible. Seul le contenu du MILIEU est maintenant
  // tronqué si nécessaire, jamais le cta.
  const middleBudget = Math.max(0, MAX_NARRATION_CHARS - anchorsLength - 4); // marge pour les 2 séparateurs ". "

  // Sélection par IMPORTANCE (benefit/proof d'abord) : additionne le coût cumulé (jamais un
  // budget par champ isolé, qui laisserait passer trop de champs mineurs avant les 2 majeurs) et
  // retient tout champ qui tient ENCORE dans le budget compte tenu de ce qui est déjà retenu.
  const selected = new Set<(typeof MIDDLE_FIELDS_NARRATIVE_ORDER)[number]>();
  let cumulativeLength = 0;
  for (const key of MIDDLE_FIELDS_PRIORITY_ORDER) {
    const value = middleFieldMap[key];
    if (!value) continue;
    const addedLength = cumulativeLength > 0 ? value.length + 2 : value.length; // +2 ~ ". "
    if (cumulativeLength + addedLength > middleBudget) continue; // ce champ précis ne tient pas, mais un suivant plus court pourrait tenir
    selected.add(key);
    cumulativeLength += addedLength;
  }

  // Rendu dans l'ordre NARRATIF (pas l'ordre de sélection) — un benefit sélectionné en priorité
  // reste affiché à sa place naturelle dans l'arc, jamais déplacé en tête du milieu.
  const middle = MIDDLE_FIELDS_NARRATIVE_ORDER.filter((k) => selected.has(k))
    .map((k) => middleFieldMap[k] as string)
    .join('. ');

  return [hook, middle, cta]
    .filter((s): s is string => !!s && s.length > 0)
    .join('. ')
    .replace(/\.\.\s*/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateJoined(parts: string[]): string {
  const joined = parts.join('. ').replace(/\.\.\s*/g, '. ').replace(/\s+/g, ' ').trim();
  return joined.length > MAX_NARRATION_CHARS ? `${joined.slice(0, MAX_NARRATION_CHARS).trim()}…` : joined;
}

function truncateForNarration(text: string, maxChars = 140): string {
  const trimmed = text.trim();
  const firstSentence = /^[^.!?\n]+[.!?]?/.exec(trimmed)?.[0]?.replace(/[.!?]+$/, '').trim();
  if (firstSentence && firstSentence.length <= maxChars) return firstSentence;
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars).trim()}…` : trimmed;
}
