'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRequireAuth } from '@/lib/use-require-auth';
import { api } from '@/lib/api';
import { Nav } from '@/components/nav';
import { Card, Button } from '@/components/ui';

export default function CampaignsPage() {
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <h1 style={{ fontSize: 22, fontWeight: 500 }}>Campagnes</h1>
          <Link href="/campaigns/new">
            <Button>Nouvelle campagne</Button>
          </Link>
        </div>

        {loading && <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>Chargement...</p>}

        <div style={{ display: 'grid', gap: 12 }}>
          {campaigns.map((c) => (
            <Link key={c.id} href={`/campaigns/${c.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <Card>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <strong style={{ fontSize: 15 }}>{c.name}</strong>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{c.status}</span>
                </div>
                {c.objective && <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 0 }}>{c.objective}</p>}
              </Card>
            </Link>
          ))}
        </div>
      </main>
    </>
  );
}
