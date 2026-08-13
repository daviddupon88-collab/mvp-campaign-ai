'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Button } from '@/components/ui';
import { PricingGrid } from '@/components/pricing-grid';
import { LanguageSwitcher } from '@/components/language-switcher';

export default function LandingPage() {
  const router = useRouter();
  const t = useTranslations('common');
  const tBilling = useTranslations('billing');
  const [plans, setPlans] = useState<any[]>([]);

  const FEATURES = [
    { title: t('landing.features.aiAnalysis.title'), desc: t('landing.features.aiAnalysis.desc') },
    { title: t('landing.features.strategy.title'), desc: t('landing.features.strategy.desc') },
    { title: t('landing.features.multichannel.title'), desc: t('landing.features.multichannel.desc') },
    { title: t('landing.features.humanReview.title'), desc: t('landing.features.humanReview.desc') },
    { title: t('landing.features.optimization.title'), desc: t('landing.features.optimization.desc') },
    { title: t('landing.features.multiTeam.title'), desc: t('landing.features.multiTeam.desc') },
  ];

  useEffect(() => {
    // Un visiteur déjà connecté n'a aucune raison de revoir la landing page.
    const token = localStorage.getItem('accessToken');
    if (token) {
      router.replace('/dashboard');
      return;
    }
    api.listPlans().then(setPlans).catch(() => setPlans([]));
  }, [router]);

  return (
    <main>
      {/* Barre de navigation */}
      <nav style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 32px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'var(--font-space-grotesk)', fontWeight: 600, fontSize: 16 }}>
          <span style={{ width: 24, height: 24, borderRadius: 7, background: 'linear-gradient(135deg, var(--accent-brand), var(--accent-done))', flexShrink: 0 }} />
          Campaign-ai
        </span>
        <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
          <Link href="/pricing" style={{ fontSize: 14, color: 'var(--text-secondary)', textDecoration: 'none' }}>{t('footer.pricing')}</Link>
          <Link href="/login" style={{ fontSize: 14, color: 'var(--text-secondary)', textDecoration: 'none' }}>{t('landing.login')}</Link>
          <LanguageSwitcher />
          <Link href="/register"><Button>{t('landing.freeTrialCta')}</Button></Link>
        </div>
      </nav>

      {/* Hero */}
      <section style={{ maxWidth: 720, margin: '0 auto', padding: '90px 24px 60px', textAlign: 'center' }}>
        <span
          className="mono"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5,
            color: 'var(--accent-done)', background: 'var(--accent-done-dim)',
            padding: '6px 14px', borderRadius: 20, marginBottom: 24,
          }}
        >
          {t('landing.poweredBy')}
        </span>
        <h1 style={{ fontSize: 40, lineHeight: 1.15, margin: '0 0 20px', fontWeight: 600 }}>
          {t('landing.heroTitle')}
        </h1>
        <p style={{ fontSize: 17, color: 'var(--text-secondary)', margin: '0 0 32px', lineHeight: 1.6 }}>
          {t('landing.heroSubtitle')}
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
          <Link href="/register"><Button>{t('landing.startFree')}</Button></Link>
          <a href="#features"><Button variant="secondary">{t('landing.seeFeatures')}</Button></a>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 16 }}>
          {t('landing.trialNoCard')}
        </p>
      </section>

      {/* Fonctionnalités */}
      <section id="features" style={{ maxWidth: 960, margin: '0 auto', padding: '40px 24px 80px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 20 }}>
          {FEATURES.map((f) => (
            <Card key={f.title}>
              <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>{f.title}</h3>
              <p style={{ fontSize: 13.5, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.6 }}>{f.desc}</p>
            </Card>
          ))}
        </div>
      </section>

      {/* Tarifs (données réelles, GET /plans public) */}
      <section style={{ borderTop: '1px solid var(--border)', padding: '64px 24px' }}>
        <div style={{ maxWidth: 1040, margin: '0 auto' }}>
          <h2 style={{ textAlign: 'center', fontSize: 24, marginBottom: 8 }}>{tBilling('landingPricingTitle')}</h2>
          <p style={{ textAlign: 'center', fontSize: 14, color: 'var(--text-secondary)', marginBottom: 40 }}>
            {tBilling('pricingSubtitle')}
          </p>
          <PricingGrid plans={plans} ctaHref="/register" />
        </div>
      </section>

      <footer style={{ textAlign: 'center', padding: '32px 24px', fontSize: 12.5, color: 'var(--text-muted)' }}>
        © Campaign-ai · <Link href="/pricing" style={{ color: 'inherit' }}>{t('footer.pricing')}</Link>
      </footer>
    </main>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 20 }}>
      {children}
    </div>
  );
}
