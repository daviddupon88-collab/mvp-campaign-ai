// P0.1 — Creative Intelligence (chantier "Creative Intelligence Engine & Video Quality Loop",
// 2026-08-18). Transforme Product Intelligence + stratégie marketing en une intelligence
// publicitaire structurée — pas encore une idée de pub concrète (cf. CreativeConcept, P0.2),
// mais les décisions qui la fondent : à qui on parle, quel problème/désir/bénéfice, quel angle,
// quelle preuve MONTRER (SHOW > TELL, règle explicite du brief) plutôt qu'énoncer.
export interface CreativeIntelligence {
  adObjective: string;
  targetAudience: string;
  primaryProblem: string;
  primaryDesire: string;
  primaryBenefit: string;
  valueProposition: string;
  creativeAngle: string;
  desiredEmotion: string;
  hook: string;
  // Ce qu'il faut MONTRER visuellement pour prouver le bénéfice — jamais une affirmation à
  // énoncer telle quelle si elle n'est pas déjà confirmée par le Product Intelligence Profile.
  proofToShow: string;
  objections: string[];
  mainMessage: string;
  cta: string;
  visualTone: string;
  pacing: string;
  adStyle: string;
  // Réponse brute du modèle — convention de parsing défensif partagée dans tout ce chantier
  // (cf. VisualDnaService.parse, ProductVisionAnalysisService) : jamais perdue, même en repli.
  raw: string;
}
