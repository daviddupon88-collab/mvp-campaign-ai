'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { PricingGrid } from '@/components/pricing-grid';

export default function PricingPage() {
  const [plans, setPlans] = useState<any[]>([]);

  useEffect(() => {
    api.listPlans().then(setPlans).catch(() => setPlans([]));
  }, []);

  return (
    <main>
      <nav style={{ padding: '20px 32px', borderBottom: '1px solid var(--border)' }}>
        <Link href="/" style={{ fontFamily: 'var(--font-space-grotesk)', fontWeight: 600, fontSize: 16, textDecoration: 'none', color: 'var(--text-primary)' }}>Campaign-ai</Link>
      </nav>
      <div style={{ maxWidth: 1040, margin: '0 auto', padding: '56px 24px' }}>
        <h1 style={{ textAlign: 'center', fontSize: 28, marginBottom: 8 }}>Tarifs</h1>
        <p style={{ textAlign: 'center', fontSize: 14, color: 'var(--text-secondary)', marginBottom: 40 }}>
          14 jours d'essai gratuit sur tous les plans — aucune carte bancaire requise pour commencer.
        </p>
        <PricingGrid plans={plans} ctaHref="/register" />
      </div>
    </main>
  );
}
