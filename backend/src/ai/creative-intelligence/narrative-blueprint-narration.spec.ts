import { buildNarrationFromBlueprint } from './narrative-blueprint-narration';
import { NarrativeBlueprint } from './narrative-blueprint.types';

function buildBlueprint(overrides: Partial<NarrativeBlueprint> = {}): NarrativeBlueprint {
  return {
    hook: '', problem: '', tension: '', reveal: '', productIntroduction: '',
    benefit: '', proof: '', emotionalPayoff: '', cta: '',
    pacing: '', pausePoints: [], beats: [], raw: '{}',
    ...overrides,
  };
}

describe('buildNarrationFromBlueprint', () => {
  it('joint les champs narratifs non vides, dans l\'ordre, en une narration continue', () => {
    const blueprint = buildBlueprint({ hook: 'Un chantier plongé dans le noir', benefit: 'Visible à 360°', cta: 'Commandez la vôtre' });

    const narration = buildNarrationFromBlueprint(blueprint, 'x');

    expect(narration).toBe('Un chantier plongé dans le noir. Visible à 360°. Commandez la vôtre');
  });

  it('ignore les champs vides sans laisser de ponctuation ou d\'espaces orphelins', () => {
    const blueprint = buildBlueprint({ hook: 'Hook.', problem: '', tension: '  ', reveal: 'Révélation' });

    const narration = buildNarrationFromBlueprint(blueprint, 'x');

    expect(narration).not.toMatch(/\.\s*\./);
    expect(narration).not.toMatch(/\s{2,}/);
    expect(narration).toContain('Hook');
    expect(narration).toContain('Révélation');
  });

  it('tronque avec ellipse au-delà de la limite de longueur', () => {
    const longField = 'x'.repeat(500);
    const blueprint = buildBlueprint({ hook: longField });

    const narration = buildNarrationFromBlueprint(blueprint, 'x');

    expect(narration.length).toBeLessThan(450);
    expect(narration.endsWith('…')).toBe(true);
  });

  it('blueprint entièrement vide (échec de parsing) : repli catégorie/USP depuis productDescriptionFallback structuré', () => {
    const blueprint = buildBlueprint();
    const description = 'Catégorie détectée : gilets de sécurité\nFourchette de prix estimée : 20-40€\nForces : visibilité\nUSP : bandes réfléchissantes haute intensité';

    const narration = buildNarrationFromBlueprint(blueprint, description);

    expect(narration).toContain('gilets de sécurité');
    expect(narration).toContain('bandes réfléchissantes haute intensité');
  });

  it('blueprint vide ET description non structurée : repli ultime "Découvrez {description}."', () => {
    const blueprint = buildBlueprint();

    const narration = buildNarrationFromBlueprint(blueprint, 'des chaussures de course légères');

    expect(narration).toBe('Découvrez des chaussures de course légères.');
  });

  it('ne renvoie jamais une chaîne vide, même dans le pire cas (blueprint vide + description vide)', () => {
    const blueprint = buildBlueprint();

    const narration = buildNarrationFromBlueprint(blueprint, '');

    expect(narration.trim().length).toBeGreaterThan(0);
  });

  // Mission 4.5 (Contrôle A1, campagne réelle 2026-08-22) — bug réel confirmé : le cta,
  // toujours en dernière position dans l'ancien concat, était tronqué en premier dès que le
  // contenu du milieu dépassait le budget. Observé en production : CTA vocal jamais prononcé,
  // narration terminée sur un mot incompréhensible.
  describe('préservation du hook et du cta (correction Mission 4.5)', () => {
    it('cta TOUJOURS présent intégralement, même quand le contenu du milieu dépasse le budget à lui seul', () => {
      const blueprint = buildBlueprint({
        hook: 'Un rayon rempli de bouteilles identiques.',
        problem: 'x'.repeat(200),
        tension: 'y'.repeat(200),
        reveal: 'z'.repeat(200),
        cta: 'Achetez maintenant — Lalla Khedidja, 1,5L, en ligne.',
      });

      const narration = buildNarrationFromBlueprint(blueprint, 'x');

      expect(narration).toContain('Achetez maintenant — Lalla Khedidja, 1,5L, en ligne.');
      expect(narration.endsWith('Achetez maintenant — Lalla Khedidja, 1,5L, en ligne.')).toBe(true);
    });

    it('hook TOUJOURS présent intégralement dans le même scénario', () => {
      const blueprint = buildBlueprint({
        hook: 'Un rayon rempli de bouteilles identiques.',
        problem: 'x'.repeat(200),
        tension: 'y'.repeat(200),
        cta: 'Achetez maintenant.',
      });

      const narration = buildNarrationFromBlueprint(blueprint, 'x');

      expect(narration.startsWith('Un rayon rempli de bouteilles identiques.')).toBe(true);
    });

    it('le contenu du milieu est tronqué (jamais le hook ni le cta) quand le total dépasse le budget', () => {
      const blueprint = buildBlueprint({
        hook: 'Hook court.',
        problem: 'Un problème assez long qui décrit en détail la situation initiale du client avant la découverte du produit, avec beaucoup de contexte superflu qui ne tiendra pas dans le budget alloué à la narration complète.',
        tension: 'Une tension supplémentaire qui elle aussi allonge encore le message bien au-delà de ce qui est raisonnable pour quinze secondes de publicité vidéo.',
        cta: 'CTA court.',
      });

      const narration = buildNarrationFromBlueprint(blueprint, 'x');

      expect(narration.length).toBeLessThanOrEqual(410); // budget + marge d'assemblage, jamais un dépassement massif
      expect(narration).toContain('Hook court.');
      expect(narration).toContain('CTA court.');
    });

    it('hook+cta seuls déjà au-delà du budget (cas pathologique) : repli sur la troncature historique avec ellipse', () => {
      const blueprint = buildBlueprint({ hook: 'h'.repeat(250), cta: 'c'.repeat(250) });

      const narration = buildNarrationFromBlueprint(blueprint, 'x');

      expect(narration.endsWith('…')).toBe(true);
      expect(narration.length).toBeLessThan(450);
    });
  });

  // Mission 4.5 (Phases A2-A5) — interrupteur expérimental temporaire (narration-experiment-flag.ts)
  describe('MISSION_4_5_LEGACY_NARRATION (contrôles expérimentaux Ax)', () => {
    const ORIGINAL_ENV = process.env.MISSION_4_5_LEGACY_NARRATION;
    afterEach(() => {
      if (ORIGINAL_ENV === undefined) delete process.env.MISSION_4_5_LEGACY_NARRATION;
      else process.env.MISSION_4_5_LEGACY_NARRATION = ORIGINAL_ENV;
    });

    it('flag=true : rejoue le bug historique (cta perdu quand le milieu dépasse le budget)', () => {
      process.env.MISSION_4_5_LEGACY_NARRATION = 'true';
      const blueprint = buildBlueprint({
        hook: 'Un rayon rempli de bouteilles identiques.',
        problem: 'x'.repeat(200),
        tension: 'y'.repeat(200),
        cta: 'Achetez maintenant — Lalla Khedidja, 1,5L, en ligne.',
      });

      const narration = buildNarrationFromBlueprint(blueprint, 'x');

      expect(narration).not.toContain('Achetez maintenant — Lalla Khedidja, 1,5L, en ligne.');
      expect(narration.endsWith('…')).toBe(true);
    });

    it('flag absent/false : comportement corrigé (cta toujours préservé), comportement par défaut de la production', () => {
      delete process.env.MISSION_4_5_LEGACY_NARRATION;
      const blueprint = buildBlueprint({
        hook: 'Un rayon rempli de bouteilles identiques.',
        problem: 'x'.repeat(200),
        tension: 'y'.repeat(200),
        cta: 'Achetez maintenant — Lalla Khedidja, 1,5L, en ligne.',
      });

      const narration = buildNarrationFromBlueprint(blueprint, 'x');

      expect(narration).toContain('Achetez maintenant — Lalla Khedidja, 1,5L, en ligne.');
    });
  });

  // Mission 4.6 (Narrative Execution Integrity, Phase 0 — preuve directe) — comparaison du texte
  // RÉELLEMENT envoyé à generateAudio (AiGeneration.prompt) vs creativeConcept.storytellingApproach
  // sur les campagnes réelles B2/B5 (2026-08-22) : benefit/proof, positionnés 5e/6e sur 7 champs
  // dans l'ancien ordre de remplissage narratif fixe, étaient systématiquement sacrifiés dès que
  // problem/tension/reveal/productIntroduction remplissaient déjà le budget (~350/400 caractères
  // en pratique, cas réel constaté). Corrigé : sélection par IMPORTANCE (benefit/proof = HIGH,
  // cf. mission Phase 7), rendu dans l'ordre narratif une fois la sélection faite.
  describe('priorité benefit/proof sous contrainte de budget (Mission 4.6)', () => {
    it('reproduit le cas réel B5 : problem+tension+reveal longs auraient auparavant sacrifié benefit/proof — désormais préservés', () => {
      const blueprint = buildBlueprint({
        hook: 'Une eau minérale naturelle, née des montagnes, pensée pour votre quotidien actif.',
        problem: 'Mais cette petite bouteille s\'arrête toujours trop tôt, en plein effort.',
        tension: 'Racheter sans cesse, ne jamais avoir la bonne quantité au bon moment de la journée.',
        reveal: 'Voici Lalla Khedidja, l\'eau minérale naturelle née des montagnes.',
        benefit: 'Le format 1,5L accompagne le sport, le bureau, et les sorties en famille.',
        proof: 'Étiquette montagne, bouchon bleu, reliefs ondulés qui captent la lumière.',
        cta: 'Commandez dès maintenant votre bouteille Lalla Khedidja 1,5L en ligne.',
      });

      const narration = buildNarrationFromBlueprint(blueprint, 'x');

      expect(narration).toContain('accompagne le sport'); // benefit
      expect(narration).toContain('Étiquette montagne'); // proof
    });

    it('sous contrainte de budget serrée, benefit/proof sont retenus AVANT reveal/productIntroduction/emotionalPayoff', () => {
      const blueprint = buildBlueprint({
        hook: 'Hook court.',
        reveal: 'z'.repeat(150), // priorité basse — doit céder la place
        productIntroduction: 'w'.repeat(150), // priorité basse — doit céder la place
        benefit: 'Le bénéfice essentiel du produit.',
        proof: 'La preuve visuelle essentielle.',
        cta: 'CTA court.',
      });

      const narration = buildNarrationFromBlueprint(blueprint, 'x');

      expect(narration).toContain('Le bénéfice essentiel du produit.');
      expect(narration).toContain('La preuve visuelle essentielle.');
    });

    it("l'ordre de RENDU reste narratif (problem avant benefit avant proof), même si benefit/proof sont sélectionnés en priorité", () => {
      const blueprint = buildBlueprint({
        hook: 'Hook.',
        problem: 'Problème.',
        benefit: 'Bénéfice.',
        proof: 'Preuve.',
        cta: 'CTA.',
      });

      const narration = buildNarrationFromBlueprint(blueprint, 'x');
      const indexProblem = narration.indexOf('Problème');
      const indexBenefit = narration.indexOf('Bénéfice');
      const indexProof = narration.indexOf('Preuve');

      expect(indexProblem).toBeLessThan(indexBenefit);
      expect(indexBenefit).toBeLessThan(indexProof);
    });

    it("un champ de priorité basse (ex. emotionalPayoff) peut être sacrifié seul quand tout le reste tient déjà dans le budget", () => {
      const blueprint = buildBlueprint({
        hook: 'Hook.',
        problem: 'Problème court.',
        benefit: 'Bénéfice court.',
        proof: 'Preuve courte.',
        emotionalPayoff: 'e'.repeat(400), // dépasse largement le budget restant (~337 caractères ici)
        cta: 'CTA.',
      });

      const narration = buildNarrationFromBlueprint(blueprint, 'x');

      expect(narration).toContain('Bénéfice court');
      expect(narration).toContain('Preuve courte');
      expect(narration).not.toContain('e'.repeat(400));
    });
  });
});
