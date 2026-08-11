'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';

// Nudge de conversion : affiché sur le tableau de bord tant que l'organisation est en
// essai gratuit. Le compte à rebours vient directement de trialEndsAt côté backend —
// jamais recalculé côté client à partir d'une date de création approximative, pour rester
// exact même si le backend ajuste la durée d'essai un jour.
export function TrialBanner() {
  const [subscription, setSubscription] = useState<any>(null);

  useEffect(() => {
    api.getSubscription().then(setSubscription).catch(() => setSubscription(null));
  }, []);

  if (!subscription || subscription.status !== 'trialing' || !subscription.trialEndsAt) return null;

  const daysRemaining = Math.max(0, Math.ceil((new Date(subscription.trialEndsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
  const urgent = daysRemaining <= 3;

  return (
    <div
      style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '10px 16px', borderRadius: 8, marginBottom: 20, fontSize: 13,
        background: urgent ? '#fdf1ee' : '#f0f7f4',
        border: `1px solid ${urgent ? '#e8c4b8' : '#c8e0d4'}`,
        color: urgent ? '#a3552d' : '#2d6b4f',
      }}
    >
      <span>
        {daysRemaining > 0
          ? `Votre essai gratuit se termine dans ${daysRemaining} jour${daysRemaining > 1 ? 's' : ''}.`
          : "Votre essai gratuit se termine aujourd'hui."}
      </span>
      <Link href="/settings/billing" style={{ color: 'inherit', fontWeight: 600, textDecoration: 'underline' }}>
        Choisir un plan
      </Link>
    </div>
  );
}
