import { getRequestConfig } from 'next-intl/server';
import { getUserLocale } from './get-locale';

const NAMESPACES = [
  'common',
  'navigation',
  'dashboard',
  'campaigns',
  'content-studio',
  'video',
  'analytics',
  'settings',
  'billing',
  'auth',
  'notifications',
  'errors',
] as const;

export default getRequestConfig(async () => {
  const locale = await getUserLocale();

  // Un seul import dynamique par namespace : Next.js ne charge donc jamais que les
  // fichiers de la locale réellement demandée pour cette requête (lazy-load par langue).
  const modules = await Promise.all(
    NAMESPACES.map((ns) => import(`./locales/${locale}/${ns}.json`).then((m) => [ns, m.default] as const)),
  );

  const messages = Object.fromEntries(modules.map(([ns, content]) => [toCamelCase(ns), content]));

  return { locale, messages };
});

function toCamelCase(ns: string): string {
  return ns.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
