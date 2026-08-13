'use server';

import { cookies } from 'next/headers';
import { LOCALE_COOKIE_NAME, isSupportedLocale } from './config';

// Server action appelée par le sélecteur de langue. Ne persiste jamais une valeur hors
// de SUPPORTED_LOCALES : la locale finit dans un cookie non-HttpOnly lu par next-intl,
// donc toute entrée non validée serait un vecteur d'injection de données.
export async function setLocaleCookie(locale: string): Promise<void> {
  if (!isSupportedLocale(locale)) return;
  const cookieStore = await cookies();
  cookieStore.set(LOCALE_COOKIE_NAME, locale, {
    path: '/',
    maxAge: 60 * 60 * 24 * 400,
    sameSite: 'lax',
  });
}
