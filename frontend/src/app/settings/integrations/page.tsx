'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useRequireAuth } from '@/lib/use-require-auth';
import { useCurrentUser, canManageTeam } from '@/lib/use-current-user';
import { api } from '@/lib/api';
import { Nav } from '@/components/nav';
import { Card, Button, Field, ErrorText } from '@/components/ui';

export default function IntegrationsSettingsPage() {
  const ready = useRequireAuth();
  const { user } = useCurrentUser();
  const t = useTranslations('settings.integrations');
  const [status, setStatus] = useState<{ configured: boolean; pixelId: string | null; enabled: boolean } | null>(null);
  const [pixelId, setPixelId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    api
      .getMetaCapiConfig()
      .then((result) => {
        setStatus(result);
        if (result.pixelId) setPixelId(result.pixelId);
        setEnabled(result.enabled);
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (ready) load();
  }, [ready, load]);

  if (!ready) return null;
  const canManage = canManageTeam(user?.role);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await api.updateMetaCapiConfig({ pixelId, accessToken, enabled });
      setStatus(result);
      setAccessToken('');
      setSaved(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Nav />
      <main style={{ maxWidth: 640, margin: '40px auto', padding: '0 16px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 24 }}>{t('title')}</h1>
        <ErrorText message={error} />

        <Card>
          <h2 style={{ fontSize: 15, fontWeight: 500, marginTop: 0 }}>{t('metaCapiTitle')}</h2>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>{t('metaCapiSubtitle')}</p>

          {status && (
            <p className="mono" style={{ fontSize: 12, color: status.configured ? 'var(--accent-done)' : 'var(--text-muted)', marginBottom: 16 }}>
              {status.configured ? t('configuredStatus', { pixelId: status.pixelId ?? '' }) : t('notConfiguredStatus')}
            </p>
          )}

          {canManage ? (
            <form onSubmit={save}>
              <Field label={t('pixelIdLabel')} value={pixelId} onChange={setPixelId} required placeholder={t('pixelIdPlaceholder')} />
              <Field
                label={t('accessTokenLabel')}
                type="password"
                value={accessToken}
                onChange={setAccessToken}
                required
                placeholder={t('accessTokenPlaceholder')}
              />
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: -10, marginBottom: 16 }}>{t('accessTokenHint')}</p>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, fontSize: 13.5 }}>
                <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                {t('enabledLabel')}
              </label>

              <Button type="submit" disabled={saving}>
                {saving ? t('saving') : saved ? t('saved') : t('save')}
              </Button>
            </form>
          ) : null}
        </Card>
      </main>
    </>
  );
}
