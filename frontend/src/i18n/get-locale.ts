import { cookies, headers } from 'next/headers';
import { DEFAULT_LOCALE, LOCALE_COOKIE_NAME, Locale, isSupportedLocale, matchBrowserLocale } from './config';

// Résolution serveur de la locale active. L'authentification de Campaign-ai est
// entièrement côté client (token en localStorage, cf. use-require-auth.ts) — aucune
// session n'est donc lisible ici. La préférence enregistrée sur le compte est
// synchronisée dans ce même cookie par <AccountLocaleSync> après connexion (cf.
// components/account-locale-sync.tsx), ce qui fait du cookie la source unique lue
// côté serveur tout en respectant l'ordre de priorité demandé (compte > local >
// navigateur > défaut) sans ajouter d'appel Prisma sur ce chemin exécuté à chaque requête.
export async function getUserLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get(LOCALE_COOKIE_NAME)?.value;
  if (isSupportedLocale(cookieLocale)) return cookieLocale;

  const headerStore = await headers();
  return matchBrowserLocale(headerStore.get('accept-language'));
}

export { DEFAULT_LOCALE };
