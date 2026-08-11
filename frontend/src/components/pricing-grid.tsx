'use client';

import { Button } from './ui';

interface Plan {
  key: string;
  name: string;
  priceMonthly: number | null;
  aiCreditsIncluded: number;
  maxSeats: number | null;
  maxActiveCampaigns: number | null;
  maxChannels: number | null;
  features: Record<string, boolean>;
}

// Un seul composant, deux usages : la section tarifs de la landing page (visiteur non
// connecté, CTA -> /register) et la page de paramétrage de facturation in-app (utilisateur
// connecté, CTA -> checkout Stripe direct). Les données viennent TOUJOURS de GET /plans —
// jamais de valeurs codées en dur ici, qui se désynchroniseraient inévitablement de
// plan-catalog.ts côté backend.
export function PricingGrid({
  plans,
  ctaHref,
  onSelectPlan,
  currentPlanKey,
}: {
  plans: Plan[];
  ctaHref?: string; // mode landing : lien statique vers /register
  onSelectPlan?: (planKey: string) => void; // mode in-app : déclenche le checkout Stripe
  currentPlanKey?: string;
}) {
  if (plans.length === 0) {
    return <p style={{ textAlign: 'center', color: '#9a9992', fontSize: 13 }}>Chargement des tarifs...</p>;
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
      {plans.map((plan) => {
        const isCurrent = plan.key === currentPlanKey;
        const isFeatured = plan.key === 'growth'; // plan intermédiaire mis en avant, cohérent avec le business plan

        return (
          <div
            key={plan.key}
            style={{
              background: isFeatured ? '#1a1a18' : '#fff',
              color: isFeatured ? '#fff' : '#1a1a18',
              border: `1px solid ${isFeatured ? '#1a1a18' : '#e5e3dd'}`,
              borderRadius: 12,
              padding: 22,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div style={{ fontSize: 13, color: isFeatured ? '#c9c8c3' : '#5f5e5a', marginBottom: 4 }}>{plan.name}</div>
            <div style={{ fontSize: 26, fontWeight: 600, marginBottom: 2 }}>
              {plan.priceMonthly !== null ? `${plan.priceMonthly}€` : 'Sur devis'}
              {plan.priceMonthly !== null && <span style={{ fontSize: 13, fontWeight: 400 }}> /mois</span>}
            </div>
            <div style={{ fontSize: 12, color: isFeatured ? '#8ab4a0' : '#4a9d7f', marginBottom: 16 }}>
              {plan.aiCreditsIncluded.toLocaleString('fr-FR')} crédits IA/mois
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 20px', fontSize: 12.5, flex: 1, color: isFeatured ? '#c9c8c3' : '#5f5e5a' }}>
              <li style={{ padding: '5px 0', borderTop: `1px solid ${isFeatured ? '#3a3a38' : '#eee'}` }}>
                {plan.maxSeats ? `${plan.maxSeats} sièges` : 'Sièges illimités'}
              </li>
              <li style={{ padding: '5px 0', borderTop: `1px solid ${isFeatured ? '#3a3a38' : '#eee'}` }}>
                {plan.maxActiveCampaigns ? `${plan.maxActiveCampaigns} campagnes actives` : 'Campagnes illimitées'}
              </li>
              <li style={{ padding: '5px 0', borderTop: `1px solid ${isFeatured ? '#3a3a38' : '#eee'}` }}>
                {plan.maxChannels ? `${plan.maxChannels} canaux par campagne` : 'Canaux illimités'}
              </li>
            </ul>

            {isCurrent ? (
              <Button variant="secondary" disabled>Plan actuel</Button>
            ) : ctaHref ? (
              <a href={ctaHref} style={{ textDecoration: 'none' }}>
                <Button variant={isFeatured ? 'primary' : 'secondary'}>Choisir {plan.name}</Button>
              </a>
            ) : (
              <Button variant={isFeatured ? 'primary' : 'secondary'} onClick={() => onSelectPlan?.(plan.key)}>
                {plan.priceMonthly === null ? 'Nous contacter' : 'Choisir ce plan'}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
