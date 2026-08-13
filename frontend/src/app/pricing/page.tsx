'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { api } from '@/lib/api';
import { PricingGrid } from '@/components/pricing-grid';
import { LanguageSwitcher } from '@/components/language-switcher';

export default function PricingPage() {
  const t = useTranslations('billing');
  const [plans, setPlans] = useState<any[]>([]);

  useEffect(() => {
    api.listPlans().then(setPlans).catch(() => setPlans([]));
  }, []);

  return (
    <main>
      <nav style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 32px', borderBottom: '1px solid var(--border)' }}>
        <Link href="/" style={{ fontFamily: 'var(--font-space-grotesk)', fontWeight: 600, fontSize: 16, textDecoration: 'none', color: 'var(--text-primary)' }}>Campaign-ai</Link>
        <LanguageSwitcher />
      </nav>
      <div style={{ maxWidth: 1040, margin: '0 auto', padding: '56px 24px' }}>
        <h1 style={{ textAlign: 'center', fontSize: 28, marginBottom: 8 }}>{t('pricingTitle')}</h1>
        <p style={{ textAlign: 'center', fontSize: 14, color: 'var(--text-secondary)', marginBottom: 40 }}>
          {t('pricingSubtitle')}
        </p>
        <PricingGrid plans={plans} ctaHref="/register" />
      </div>
    </main>
  );
}
