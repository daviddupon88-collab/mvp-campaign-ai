'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { api } from '@/lib/api';

// Nudge de conversion : affiché sur le tableau de bord tant que l'organisation est en
// essai gratuit. Le compte à rebours vient directement de trialEndsAt côté backend —
// jamais recalculé côté client à partir d'une date de création approximative, pour rester
// exact même si le backend ajuste la durée d'essai un jour.
export function TrialBanner() {
  const t = useTranslations('billing.trialBanner');
  const [subscription, setSubscription] = useState<any>(null);
  // Calculé au moment de la réception de `subscription`, dans le même effet — jamais
  // recalculé pendant le rendu. react-hooks/purity interdit Date.now() (impur) dans le corps
  // du composant ou d'un useMemo ; un effet reste l'endroit prévu pour ce type d'opération
  // (synchronisation avec l'horloge, un système externe au même titre que localStorage).
  const [daysRemaining, setDaysRemaining] = useState<number | null>(null);

  useEffect(() => {
    api.getSubscription().then((sub) => {
      setSubscription(sub);
      setDaysRemaining(
        sub?.trialEndsAt ? Math.max(0, Math.ceil((new Date(sub.trialEndsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24))) : null,
      );
    }).catch(() => setSubscription(null));
  }, []);

  if (!subscription || subscription.status !== 'trialing' || !subscription.trialEndsAt || daysRemaining === null) return null;

  const urgent = daysRemaining <= 3;

  return (
    <div
      style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '10px 16px', borderRadius: 8, marginBottom: 20, fontSize: 13,
        background: urgent ? 'var(--accent-danger-dim)' : 'var(--accent-done-dim)',
        border: `1px solid ${urgent ? 'var(--accent-danger)' : 'var(--accent-done)'}`,
        color: urgent ? 'var(--accent-danger)' : 'var(--accent-done)',
      }}
    >
      <span>
        {daysRemaining > 0 ? t('endsInDays', { count: daysRemaining }) : t('endsToday')}
      </span>
      <Link href="/settings/billing" style={{ color: 'inherit', fontWeight: 600, textDecoration: 'underline' }}>
        {t('choosePlan')}
      </Link>
    </div>
  );
}
