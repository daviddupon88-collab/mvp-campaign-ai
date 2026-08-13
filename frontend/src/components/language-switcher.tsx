'use client';

import { useEffect, useState, useTransition } from 'react';
import { useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { LOCALE_ACCOUNT_SYNCED_KEY, LOCALE_FLAGS, LOCALE_LABELS, Locale, SUPPORTED_LOCALES } from '@/i18n/config';
import { setLocaleCookie } from '@/i18n/set-locale';
import { api } from '@/lib/api';

// Utilisé à deux endroits : le header (compact, toujours visible) et Account Settings
// (avec libellé + aperçu "Current language"). accountLanguage vient de GET /auth/me — à la
// toute première évaluation après connexion, s'il diverge du cookie courant (ex: connexion
// sur un nouvel appareil), le compte l'emporte sur la préférence locale, conformément à
// l'ordre de priorité demandé. Ensuite, tout changement manuel dans cette session reste
// autoritaire jusqu'à la prochaine connexion (cf. LOCALE_ACCOUNT_SYNCED_KEY, effacée au logout).
export function LanguageSwitcher({ accountLanguage }: { accountLanguage?: string | null }) {
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pendingLocale, setPendingLocale] = useState<Locale | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (localStorage.getItem(LOCALE_ACCOUNT_SYNCED_KEY) === 'true') return;
    if (!accountLanguage) return; // /auth/me pas encore résolu — on retentera au prochain montage

    localStorage.setItem(LOCALE_ACCOUNT_SYNCED_KEY, 'true');
    if (accountLanguage !== locale) {
      applyLocale(accountLanguage as Locale, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountLanguage, locale]);

  function applyLocale(next: Locale, persistToAccount: boolean) {
    setPendingLocale(next);
    startTransition(async () => {
      await setLocaleCookie(next);
      if (persistToAccount && typeof window !== 'undefined' && localStorage.getItem('accessToken')) {
        api.updateLanguage(next).catch(() => {});
      }
      router.refresh();
      setPendingLocale(null);
    });
  }

  const activeLocale = pendingLocale ?? locale;

  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <select
        aria-label="Language / Sprache / Langue / اللغة"
        value={activeLocale}
        disabled={isPending}
        onChange={(e) => applyLocale(e.target.value as Locale, true)}
        style={{
          fontSize: 13,
          padding: '6px 10px',
          borderRadius: 8,
          border: '1px solid var(--border-strong)',
          background: 'var(--bg-panel)',
          color: 'var(--text-primary)',
          cursor: isPending ? 'wait' : 'pointer',
        }}
      >
        {SUPPORTED_LOCALES.map((l) => (
          <option key={l} value={l}>
            {LOCALE_FLAGS[l]} {LOCALE_LABELS[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
