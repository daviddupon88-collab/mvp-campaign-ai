export const LOCALE_COOKIE_NAME = 'NEXT_LOCALE';

// localStorage (partagé entre tous les onglets/fenêtres) — marque qu'on a déjà réconcilié
// la préférence de langue du compte avec le cookie local pour la session de connexion en
// cours. Posée une seule fois par LanguageSwitcher, effacée au logout (cf. use-require-auth.ts).
export const LOCALE_ACCOUNT_SYNCED_KEY = 'campaignai:localeAccountSynced';

export const SUPPORTED_LOCALES = ['en', 'de', 'fr', 'ar'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export const RTL_LOCALES: readonly Locale[] = ['ar'];

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  de: 'Deutsch',
  fr: 'Français',
  ar: 'العربية',
};

export const LOCALE_FLAGS: Record<Locale, string> = {
  en: '🇬🇧',
  de: '🇩🇪',
  fr: '🇫🇷',
  ar: '🇸🇦',
};

// Intl.* attend un tag BCP 47 complet (avec pays) pour en/de/fr afin de matcher les
// exemples de la mission (en-US, de-DE, fr-FR) ; l'arabe reste générique ('ar'), aucun
// marché arabophone particulier n'étant privilégié.
export const INTL_TAGS: Record<Locale, string> = {
  en: 'en-US',
  de: 'de-DE',
  fr: 'fr-FR',
  ar: 'ar',
};

export function isSupportedLocale(value: string | null | undefined): value is Locale {
  return !!value && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function isRtl(locale: string): boolean {
  return (RTL_LOCALES as readonly string[]).includes(locale);
}

// en-*, de-*, fr-*, ar-* -> en/de/fr/ar ; tout le reste -> DEFAULT_LOCALE (en).
export function matchBrowserLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const tags = acceptLanguage.split(',').map((part) => part.split(';')[0].trim().toLowerCase());
  for (const tag of tags) {
    const primary = tag.split('-')[0];
    if (isSupportedLocale(primary)) return primary;
  }
  return DEFAULT_LOCALE;
}
