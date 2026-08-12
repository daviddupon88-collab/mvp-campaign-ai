'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, api } from '@/lib/api';
import { Button } from './ui';

const LIMIT_LABELS: Record<string, string> = {
  credits: 'vos crédits IA',
  seats: 'vos sièges',
  activeCampaigns: 'vos campagnes actives',
  channels: 'vos canaux simultanés',
  images: 'vos images IA',
  videos: 'vos vidéos IA',
  socialPosts: 'vos publications',
  optimizerRuns: 'vos analyses Optimizer',
};

// Le moment de conversion demandé : plutôt qu'un message d'erreur générique, un plafond
// atteint (ApiError.isPlanLimit) ouvre ce modal avec le plan supérieur déjà identifié par
// le backend (recommendedPlan) — jamais recalculé côté client, pour rester cohérent avec
// la logique de progression commerciale définie une seule fois dans plan-catalog.ts.
export function UpgradeModal({ error, onClose }: { error: ApiError | null; onClose: () => void }) {
  const router = useRouter();
  const [plans, setPlans] = useState<any[]>([]);

  useEffect(() => {
    if (error?.isPlanLimit) api.listPlans().then(setPlans).catch(() => setPlans([]));
  }, [error]);

  if (!error?.isPlanLimit) return null;

  const recommended = plans.find((p) => p.key === error.recommendedPlan);
  const limitLabel = LIMIT_LABELS[error.limitType ?? ''] ?? 'ce plafond';

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(14,16,19,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 14, padding: 28, maxWidth: 380, width: '90%' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 13, color: 'var(--accent-danger)', fontWeight: 600, marginBottom: 8 }}>
          Plafond atteint
        </div>
        <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>Vous avez utilisé {limitLabel}</h2>
        <p style={{ fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 20 }}>
          {error.current}/{error.limit} — {recommended ? (
            <>passez au plan <strong>{recommended.name}</strong> pour continuer sans interruption.</>
          ) : (
            'passez à un plan supérieur pour continuer sans interruption.'
          )}
        </p>

        {recommended && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 16, marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
              <span style={{ fontWeight: 600 }}>{recommended.name}</span>
              <span style={{ fontSize: 20, fontWeight: 600 }}>{recommended.priceMonthly}€<span style={{ fontSize: 12, fontWeight: 400 }}>/mois</span></span>
            </div>
            <span className="mono" style={{ fontSize: 12.5, color: 'var(--accent-done)' }}>
              {recommended.aiCreditsIncluded.toLocaleString('fr-FR')} crédits IA/mois
            </span>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <Button
            onClick={() => {
              onClose();
              router.push('/settings/billing');
            }}
          >
            Voir les plans
          </Button>
          <Button variant="secondary" onClick={onClose}>Plus tard</Button>
        </div>
      </div>
    </div>
  );
}
