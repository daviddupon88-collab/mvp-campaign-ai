'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { api } from '@/lib/api';
import { useRequireAuth } from '@/lib/use-require-auth';
import { Nav } from '@/components/nav';
import { Card } from '@/components/ui';
import { PricingGrid } from '@/components/pricing-grid';
import { INTL_TAGS, Locale } from '@/i18n/config';

export default function BillingSettingsPage() {
  const ready = useRequireAuth();
  const t = useTranslations('billing');
  const tErrors = useTranslations('errors');
  const locale = useLocale();
  const intlTag = INTL_TAGS[locale as Locale] ?? 'en-US';
  const [plans, setPlans] = useState<any[]>([]);
  const [usage, setUsage] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    Promise.all([api.listPlans(), api.getUsage()])
      .then(([p, u]) => {
        setPlans(p);
        setUsage(u);
      })
      .catch((err: any) => setError(err.message ?? tErrors('generic')));
  }, [ready, tErrors]);

  if (!ready) return null;

  // Déclenche un vrai Stripe Checkout — l'utilisateur quitte l'application, paie, puis
  // revient sur cette même page (successUrl). Aucune simulation : c'est le parcours de
  // conversion réel, celui qui transforme un essai gratuit en abonnement payant.
  async function handleSelectPlan(planKey: string) {
    setError(null);
    try {
      const returnUrl = `${window.location.origin}/settings/billing`;
      const { checkoutUrl } = await api.createCheckout({ plan: planKey, successUrl: returnUrl, cancelUrl: returnUrl });
      window.location.href = checkoutUrl;
    } catch (err: any) {
      setError(err.message ?? t('checkoutError'));
    }
  }

  const currentPlanKey = usage?.plan?.key;
  const credits = usage?.usage?.aiCredits;
  const creditsPct = credits ? Math.min(100, Math.round((credits.used / credits.limit) * 100)) : 0;

  return (
    <>
      <Nav />
      <main style={{ maxWidth: 900, margin: '40px auto', padding: '0 16px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 24 }}>{t('title')}</h1>

        {usage && (
          <Card style={{ marginBottom: 24, maxWidth: 480 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13 }}>
              <span style={{ color: 'var(--text-secondary)' }}>{t('creditsUsedThisMonth')}</span>
              <span className="mono">{credits?.used ?? 0} / {credits?.limit ?? 0}</span>
            </div>
            <div style={{ height: 6, background: 'var(--border)', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${creditsPct}%`, background: creditsPct > 90 ? 'var(--accent-danger)' : 'var(--accent-brand)', borderRadius: 6 }} />
            </div>
            {usage.subscription?.status === 'trialing' && usage.subscription?.trialEndsAt && (
              <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 12, marginBottom: 0 }}>
                {t('trialEndsOn', { date: new Date(usage.subscription.trialEndsAt).toLocaleDateString(intlTag) })}
              </p>
            )}
          </Card>
        )}

        {error && <p style={{ color: 'var(--accent-danger)', fontSize: 13, marginBottom: 16 }}>{error}</p>}

        <h2 style={{ fontSize: 16, fontWeight: 500, marginBottom: 16 }}>{t('changePlan')}</h2>
        <PricingGrid plans={plans} currentPlanKey={currentPlanKey} onSelectPlan={handleSelectPlan} />
      </main>
    </>
  );
}
