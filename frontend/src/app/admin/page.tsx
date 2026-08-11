'use client';

import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/lib/use-require-auth';
import { useCurrentUser } from '@/lib/use-current-user';
import { api } from '@/lib/api';
import { Nav } from '@/components/nav';
import { Card, StatusPill, Tabs, ErrorText } from '@/components/ui';

// Le seul écran de toute l'application qui lit délibérément à travers les organisations
// plutôt qu'à l'intérieur d'une seule — cf. PlatformAdminGuard côté backend. isPlatformAdmin
// n'étant jamais accordé en self-service, un visiteur qui arrive ici sans ce droit voit un
// message clair plutôt qu'un écran vide ou une erreur 403 brute.
export default function AdminPage() {
  const ready = useRequireAuth();
  const { user, loading } = useCurrentUser();
  const [tab, setTab] = useState('Organisations');

  if (!ready || loading) return null;
  if (!user?.isPlatformAdmin) {
    return (
      <>
        <Nav />
        <main style={{ maxWidth: 500, margin: '80px auto', textAlign: 'center', padding: '0 16px' }}>
          <p style={{ fontSize: 14, color: '#5f5e5a' }}>
            Cette section est réservée à l'équipe Campaign-ai. Si vous pensez devoir y avoir
            accès, contactez un administrateur plateforme.
          </p>
        </main>
      </>
    );
  }

  return (
    <>
      <Nav />
      <main style={{ maxWidth: 900, margin: '40px auto', padding: '0 16px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 24 }}>Administration plateforme</h1>
        <Tabs tabs={['Organisations', 'Abonnements', 'Coûts IA', 'Erreurs', 'Activité']} active={tab} onChange={setTab} />
        {tab === 'Organisations' && <OrganizationsTab />}
        {tab === 'Abonnements' && <SubscriptionsTab />}
        {tab === 'Coûts IA' && <AiCostsTab />}
        {tab === 'Erreurs' && <ErrorsTab />}
        {tab === 'Activité' && <ActivityTab />}
      </main>
    </>
  );
}

function OrganizationsTab() {
  const [data, setData] = useState<{ total: number; organizations: any[] } | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.adminListOrganizations(search ? { search } : undefined).then(setData).catch((err) => setError(err.message));
  }, [search]);

  async function suspend(id: string) {
    const reason = prompt('Motif de suspension (tracé dans la piste d\'audit) :');
    if (!reason) return;
    try { await api.adminSuspendOrganization(id, reason); setData(await api.adminListOrganizations()); }
    catch (err: any) { setError(err.message); }
  }
  async function reactivate(id: string) {
    try { await api.adminReactivateOrganization(id); setData(await api.adminListOrganizations()); }
    catch (err: any) { setError(err.message); }
  }

  return (
    <>
      <ErrorText message={error} />
      <input
        placeholder="Rechercher une organisation..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #d8d6cf', fontSize: 14, marginBottom: 16, boxSizing: 'border-box' }}
      />
      {data?.organizations.map((org) => (
        <Card key={org.id} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>{org.name}</div>
              <div style={{ fontSize: 12, color: '#9a9992', marginTop: 2 }}>
                {org.plan} · {org.memberCount} membre{org.memberCount > 1 ? 's' : ''} · {org.campaignCount} campagne{org.campaignCount > 1 ? 's' : ''} · {org.aiCreditsUsed}/{org.aiCreditsIncluded} crédits{org.extraCredits > 0 ? ` (+${org.extraCredits} pack)` : ''}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              {org.subscriptionStatus && <StatusPill status={org.subscriptionStatus} />}
              {org.subscriptionStatus === 'suspended' ? (
                <button onClick={() => reactivate(org.id)} style={{ fontSize: 12, background: 'none', border: 'none', color: '#4a9d7f', cursor: 'pointer' }}>Réactiver</button>
              ) : (
                <button onClick={() => suspend(org.id)} style={{ fontSize: 12, background: 'none', border: 'none', color: '#a3352d', cursor: 'pointer' }}>Suspendre</button>
              )}
            </div>
          </div>
        </Card>
      ))}
    </>
  );
}

function SubscriptionsTab() {
  const [data, setData] = useState<any>(null);
  useEffect(() => { api.adminSubscriptionsOverview().then(setData); }, []);
  if (!data) return null;

  return (
    <>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: '#5f5e5a' }}>MRR estimé</div>
        <div style={{ fontSize: 28, fontWeight: 600 }}>{data.estimatedMrrUsd.toLocaleString('fr-FR')} €</div>
      </Card>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card>
          <h3 style={{ fontSize: 13.5, marginTop: 0 }}>Par plan</h3>
          {Object.entries(data.byPlan).map(([plan, count]) => (
            <div key={plan} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
              <span>{plan}</span><span className="mono">{count as number}</span>
            </div>
          ))}
        </Card>
        <Card>
          <h3 style={{ fontSize: 13.5, marginTop: 0 }}>Par statut</h3>
          {Object.entries(data.byStatus).map(([status, count]) => (
            <div key={status} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
              <span>{status}</span><span className="mono">{count as number}</span>
            </div>
          ))}
        </Card>
      </div>
    </>
  );
}

function AiCostsTab() {
  const [data, setData] = useState<any>(null);
  useEffect(() => { api.adminAiCostsOverview().then(setData); }, []);
  if (!data) return null;

  return (
    <>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: '#5f5e5a' }}>Coût IA ce mois-ci ({data.totalCalls} appels)</div>
        <div style={{ fontSize: 28, fontWeight: 600 }}>{data.totalCostUsd.toFixed(2)} $</div>
      </Card>
      <Card style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 13.5, marginTop: 0 }}>Par fournisseur</h3>
        {data.byProvider.map((p: any) => (
          <div key={p.provider} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
            <span>{p.provider}</span><span className="mono">{p.costUsd.toFixed(2)} $</span>
          </div>
        ))}
      </Card>
      <Card>
        <h3 style={{ fontSize: 13.5, marginTop: 0 }}>Top organisations par dépense</h3>
        {data.topOrganizationsBySpend.map((o: any) => (
          <div key={o.organizationId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
            <span>{o.organizationName}</span><span className="mono">{o.costUsd.toFixed(2)} $</span>
          </div>
        ))}
      </Card>
    </>
  );
}

function ErrorsTab() {
  const [data, setData] = useState<any>(null);
  useEffect(() => { api.adminRecentErrors().then(setData); }, []);
  if (!data) return null;

  return (
    <>
      <Card style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 13.5, marginTop: 0 }}>Générations IA échouées</h3>
        {data.failedAiGenerations.length === 0 ? <p style={{ fontSize: 13, color: '#9a9992' }}>Aucune.</p> : data.failedAiGenerations.map((g: any) => (
          <div key={g.id} style={{ padding: '8px 0', borderTop: '1px solid #eee', fontSize: 12.5 }}>
            <strong>{g.taskType}</strong> · {g.provider} — {g.errorMessage}
          </div>
        ))}
      </Card>
      <Card>
        <h3 style={{ fontSize: 13.5, marginTop: 0 }}>Publications échouées</h3>
        {data.failedPublications.length === 0 ? <p style={{ fontSize: 13, color: '#9a9992' }}>Aucune.</p> : data.failedPublications.map((p: any) => (
          <div key={p.id} style={{ padding: '8px 0', borderTop: '1px solid #eee', fontSize: 12.5 }}>
            <strong>{p.platform}</strong> · {p.attemptCount} tentative(s) — {p.errorMessage}
          </div>
        ))}
      </Card>
    </>
  );
}

function ActivityTab() {
  const [entries, setEntries] = useState<any[]>([]);
  useEffect(() => { api.adminActivityFeed().then(setEntries); }, []);

  return (
    <Card>
      {entries.length === 0 ? <p style={{ fontSize: 13, color: '#9a9992' }}>Aucune activité récente.</p> : entries.map((e) => (
        <div key={e.id} style={{ padding: '8px 0', borderTop: '1px solid #eee', fontSize: 12.5, display: 'flex', justifyContent: 'space-between' }}>
          <span><strong>{e.action}</strong> {e.actorEmail ? `par ${e.actorEmail}` : ''}</span>
          <span style={{ color: '#9a9992' }}>{new Date(e.createdAt).toLocaleString('fr-FR')}</span>
        </div>
      ))}
    </Card>
  );
}
