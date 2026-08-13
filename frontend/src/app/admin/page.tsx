'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRequireAuth } from '@/lib/use-require-auth';
import { useCurrentUser } from '@/lib/use-current-user';
import { api } from '@/lib/api';
import { Nav } from '@/components/nav';
import { Card, StatusPill, Tabs, ErrorText } from '@/components/ui';
import { INTL_TAGS, Locale } from '@/i18n/config';

type AdminTab = 'organizations' | 'subscriptions' | 'aiCosts' | 'errors' | 'activity';

// Le seul écran de toute l'application qui lit délibérément à travers les organisations
// plutôt qu'à l'intérieur d'une seule — cf. PlatformAdminGuard côté backend. isPlatformAdmin
// n'étant jamais accordé en self-service, un visiteur qui arrive ici sans ce droit voit un
// message clair plutôt qu'un écran vide ou une erreur 403 brute.
export default function AdminPage() {
  const ready = useRequireAuth();
  const { user, loading } = useCurrentUser();
  const t = useTranslations('settings.admin');
  const [tab, setTab] = useState<AdminTab>('organizations');

  if (!ready || loading) return null;
  if (!user?.isPlatformAdmin) {
    return (
      <>
        <Nav />
        <main style={{ maxWidth: 500, margin: '80px auto', textAlign: 'center', padding: '0 16px' }}>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
            {t('restricted')}
          </p>
        </main>
      </>
    );
  }

  return (
    <>
      <Nav />
      <main style={{ maxWidth: 900, margin: '40px auto', padding: '0 16px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 24 }}>{t('title')}</h1>
        <Tabs
          tabs={[
            { key: 'organizations', label: t('tabs.organizations') },
            { key: 'subscriptions', label: t('tabs.subscriptions') },
            { key: 'aiCosts', label: t('tabs.aiCosts') },
            { key: 'errors', label: t('tabs.errors') },
            { key: 'activity', label: t('tabs.activity') },
          ]}
          active={tab}
          onChange={(next) => setTab(next as AdminTab)}
        />
        {tab === 'organizations' && <OrganizationsTab />}
        {tab === 'subscriptions' && <SubscriptionsTab />}
        {tab === 'aiCosts' && <AiCostsTab />}
        {tab === 'errors' && <ErrorsTab />}
        {tab === 'activity' && <ActivityTab />}
      </main>
    </>
  );
}

function OrganizationsTab() {
  const t = useTranslations('settings.admin');
  const [data, setData] = useState<{ total: number; organizations: any[] } | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.adminListOrganizations(search ? { search } : undefined).then(setData).catch((err) => setError(err.message));
  }, [search]);

  async function suspend(id: string) {
    const reason = prompt(t('suspendPrompt'));
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
        placeholder={t('searchOrganizations')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border-strong)', fontSize: 14, marginBottom: 16, boxSizing: 'border-box' }}
      />
      {data?.organizations.map((org) => (
        <Card key={org.id} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>{org.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                {org.plan} · {t('membersCount', { count: org.memberCount })} · {t('campaignsCount', { count: org.campaignCount })} · {t('creditsUsed', { used: org.aiCreditsUsed, included: org.aiCreditsIncluded })}{org.extraCredits > 0 ? t('extraCreditsPack', { count: org.extraCredits }) : ''}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              {org.subscriptionStatus && <StatusPill status={org.subscriptionStatus} />}
              {org.subscriptionStatus === 'suspended' ? (
                <button onClick={() => reactivate(org.id)} style={{ fontSize: 12, background: 'none', border: 'none', color: 'var(--accent-done)', cursor: 'pointer' }}>{t('reactivate')}</button>
              ) : (
                <button onClick={() => suspend(org.id)} style={{ fontSize: 12, background: 'none', border: 'none', color: 'var(--accent-danger)', cursor: 'pointer' }}>{t('suspend')}</button>
              )}
            </div>
          </div>
        </Card>
      ))}
    </>
  );
}

function SubscriptionsTab() {
  const t = useTranslations('settings.admin');
  const locale = useLocale();
  const intlTag = INTL_TAGS[locale as Locale] ?? 'en-US';
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.adminSubscriptionsOverview().then(setData).catch((err: any) => setError(err.message)); }, []);
  if (!data) return <ErrorText message={error} />;

  return (
    <>
      <ErrorText message={error} />
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('estimatedMrr')}</div>
        <div style={{ fontSize: 28, fontWeight: 600 }}>{new Intl.NumberFormat(intlTag).format(data.estimatedMrrUsd)} €</div>
      </Card>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card>
          <h3 style={{ fontSize: 13.5, marginTop: 0 }}>{t('byPlan')}</h3>
          {Object.entries(data.byPlan).map(([plan, count]) => (
            <div key={plan} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
              <span>{plan}</span><span className="mono">{count as number}</span>
            </div>
          ))}
        </Card>
        <Card>
          <h3 style={{ fontSize: 13.5, marginTop: 0 }}>{t('byStatus')}</h3>
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
  const t = useTranslations('settings.admin');
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.adminAiCostsOverview().then(setData).catch((err: any) => setError(err.message)); }, []);
  if (!data) return <ErrorText message={error} />;

  return (
    <>
      <ErrorText message={error} />
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('aiCostThisMonth', { count: data.totalCalls })}</div>
        <div style={{ fontSize: 28, fontWeight: 600 }}>{data.totalCostUsd.toFixed(2)} $</div>
      </Card>
      <Card style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 13.5, marginTop: 0 }}>{t('byProvider')}</h3>
        {data.byProvider.map((p: any) => (
          <div key={p.provider} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
            <span>{p.provider}</span><span className="mono">{p.costUsd.toFixed(2)} $</span>
          </div>
        ))}
      </Card>
      <Card>
        <h3 style={{ fontSize: 13.5, marginTop: 0 }}>{t('topSpenders')}</h3>
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
  const t = useTranslations('settings.admin');
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.adminRecentErrors().then(setData).catch((err: any) => setError(err.message)); }, []);
  if (!data) return <ErrorText message={error} />;

  return (
    <>
      <ErrorText message={error} />
      <Card style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 13.5, marginTop: 0 }}>{t('httpErrors')}</h3>
        {data.httpErrors.length === 0 ? <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t('none')}</p> : data.httpErrors.map((e: any) => (
          <div key={e.id} style={{ padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: 12.5 }}>
            <strong>{e.statusCode}</strong> {e.method} {e.path} — {e.message}
          </div>
        ))}
      </Card>
      <Card style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 13.5, marginTop: 0 }}>{t('failedGenerations')}</h3>
        {data.failedAiGenerations.length === 0 ? <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t('none')}</p> : data.failedAiGenerations.map((g: any) => (
          <div key={g.id} style={{ padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: 12.5 }}>
            <strong>{g.taskType}</strong> · {g.provider} — {g.errorMessage}
          </div>
        ))}
      </Card>
      <Card>
        <h3 style={{ fontSize: 13.5, marginTop: 0 }}>{t('failedPublications')}</h3>
        {data.failedPublications.length === 0 ? <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t('none')}</p> : data.failedPublications.map((p: any) => (
          <div key={p.id} style={{ padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: 12.5 }}>
            <strong>{p.platform}</strong> · {t('attempts', { count: p.attemptCount })} — {p.errorMessage}
          </div>
        ))}
      </Card>
    </>
  );
}

function ActivityTab() {
  const t = useTranslations('settings.admin');
  const locale = useLocale();
  const intlTag = INTL_TAGS[locale as Locale] ?? 'en-US';
  const [entries, setEntries] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.adminActivityFeed().then(setEntries).catch((err: any) => setError(err.message)); }, []);

  return (
    <Card>
      <ErrorText message={error} />
      {entries.length === 0 ? <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t('noActivity')}</p> : entries.map((e) => (
        <div key={e.id} style={{ padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: 12.5, display: 'flex', justifyContent: 'space-between' }}>
          <span><strong>{e.action}</strong> {e.actorEmail ? t('by', { email: e.actorEmail }) : ''}</span>
          <span style={{ color: 'var(--text-muted)' }}>{new Date(e.createdAt).toLocaleString(intlTag)}</span>
        </div>
      ))}
    </Card>
  );
}
