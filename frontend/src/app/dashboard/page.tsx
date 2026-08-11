'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRequireAuth } from '@/lib/use-require-auth';
import { api } from '@/lib/api';
import { Nav } from '@/components/nav';
import { Card, Button } from '@/components/ui';
import { TrialBanner } from '@/components/trial-banner';
import { QuotaUsage } from '@/components/quota-usage';

export default function DashboardPage() {
  const ready = useRequireAuth();
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ready) return;
    api
      .listCampaigns()
      .then(setCampaigns)
      .finally(() => setLoading(false));
  }, [ready]);

  if (!ready) return null;

  return (
    <>
      <Nav />
      <main style={{ maxWidth: 800, margin: '40px auto', padding: '0 16px' }}>
        <TrialBanner />
        <QuotaUsage />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <h1 style={{ fontSize: 22, fontWeight: 500 }}>Tableau de bord</h1>
          <Link href="/campaigns/new">
            <Button>Nouvelle campagne</Button>
          </Link>
        </div>

        <Card>
          <h2 style={{ fontSize: 16, fontWeight: 500, marginTop: 0 }}>Campagnes récentes</h2>
          {loading && <p style={{ color: '#5f5e5a', fontSize: 14 }}>Chargement...</p>}
          {!loading && campaigns.length === 0 && (
            <p style={{ color: '#5f5e5a', fontSize: 14 }}>
              Aucune campagne pour le moment. Créez-en une pour lancer l'orchestration IA.
            </p>
          )}
          {campaigns.map((c) => (
            <Link
              key={c.id}
              href={`/campaigns/${c.id}`}
              style={{
                display: 'block',
                padding: '12px 0',
                borderTop: '1px solid #eee',
                textDecoration: 'none',
                color: '#1a1a18',
              }}
            >
              <strong style={{ fontSize: 14 }}>{c.name}</strong>
              <span style={{ marginLeft: 12, fontSize: 12, color: '#5f5e5a' }}>{c.status}</span>
            </Link>
          ))}
        </Card>
      </main>
    </>
  );
}
