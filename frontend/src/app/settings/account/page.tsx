'use client';

import { useTranslations } from 'next-intl';
import { useRequireAuth } from '@/lib/use-require-auth';
import { useCurrentUser } from '@/lib/use-current-user';
import { Nav } from '@/components/nav';
import { Card } from '@/components/ui';
import { LanguageSwitcher } from '@/components/language-switcher';
import { LOCALE_LABELS, Locale } from '@/i18n/config';

export default function AccountSettingsPage() {
  const ready = useRequireAuth();
  const { user } = useCurrentUser();
  const t = useTranslations('settings.account');

  if (!ready) return null;

  const currentLanguage = user?.preferredLanguage as Locale | undefined;

  return (
    <>
      <Nav />
      <main style={{ maxWidth: 560, margin: '40px auto', padding: '0 16px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 24 }}>{t('title')}</h1>
        <Card>
          <h2 style={{ fontSize: 15, fontWeight: 500, marginTop: 0 }}>{t('language')}</h2>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 0, marginBottom: 16 }}>{t('languageHint')}</p>
          <div style={{ marginBottom: 12 }}>
            <LanguageSwitcher accountLanguage={currentLanguage} />
          </div>
          {currentLanguage && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
              {t('currentLanguage')}: {LOCALE_LABELS[currentLanguage]}
            </p>
          )}
        </Card>
      </main>
    </>
  );
}
