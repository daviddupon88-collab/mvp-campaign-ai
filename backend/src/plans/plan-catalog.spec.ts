import { creditCostFor, CREDIT_COSTS, getPlan } from './plan-catalog';

describe('plan-catalog', () => {
  describe('creditCostFor', () => {
    it('retourne le coût exact pour une combinaison connue', () => {
      expect(creditCostFor('campaign_generation', 'generateText')).toBe(8);
      expect(creditCostFor('campaign_generation', 'generateImage')).toBe(25);
      expect(creditCostFor('campaign_generation', 'generateVideo')).toBe(150);
    });

    it('la modération de texte (moderateText) est gratuite pour le client', () => {
      // Sécurité, pas une fonctionnalité vendue — cf. commentaire dans plan-catalog.ts.
      expect(creditCostFor('moderation', 'moderateText')).toBe(0);
    });

    it('retourne un repli prudent (5) pour une combinaison non cataloguée', () => {
      expect(creditCostFor('purpose_inconnu', 'generateText')).toBe(5);
      expect(creditCostFor('campaign_generation', 'tache_inconnue')).toBe(5);
    });

    it('la génération vidéo est toujours le poste le plus coûteux en crédits campagne', () => {
      // Reflète le chapitre 3.5 du Volume 2 du business plan : "la vidéo représente déjà
      // près de 70% du coût IA" — un changement de cette invariante serait significatif.
      const { generateText, generateImage, generateVideo } = CREDIT_COSTS.campaign_generation;
      expect(generateVideo).toBeGreaterThan(generateImage);
      expect(generateImage).toBeGreaterThan(generateText);
    });
  });

  describe('getPlan', () => {
    it('retourne la définition du plan pour une clé connue', () => {
      const plan = getPlan('starter');
      expect(plan.key).toBe('starter');
      expect(plan.aiCreditsIncluded).toBeGreaterThan(0);
    });

    it('lève une erreur explicite pour un plan inconnu plutôt que de retourner undefined', () => {
      expect(() => getPlan('plan-qui-n-existe-pas')).toThrow();
    });

    it('chaque plan du catalogue a des crédits croissants avec le tarif', () => {
      const order = ['starter', 'growth', 'business'];
      for (let i = 1; i < order.length; i++) {
        const prev = getPlan(order[i - 1]);
        const curr = getPlan(order[i]);
        expect(curr.aiCreditsIncluded).toBeGreaterThan(prev.aiCreditsIncluded);
      }
    });
  });
});
