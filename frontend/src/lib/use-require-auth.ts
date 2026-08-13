'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

// Redirige vers /login si aucun token n'est présent.
// MVP: vérification côté client uniquement — le backend revalide toujours le JWT sur chaque appel API.
export function useRequireAuth() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Synchronisation avec un système externe non disponible pendant le rendu serveur
    // (localStorage) — cas d'usage explicitement valide pour useEffect, pas un état dérivable
    // autrement : impossible de lire localStorage avant le montage sans provoquer une
    // divergence SSR/client. react-hooks/set-state-in-effect signale ce setState comme
    // synchrone dans l'effet, mais c'est précisément le but ici (portail d'attente tant que
    // la vérification n'a pas eu lieu), pas un état dérivable par ailleurs.
    const token = localStorage.getItem('accessToken');
    if (!token) {
      router.replace('/login');
    } else {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setReady(true);
    }
  }, [router]);

  return ready;
}

export function logout(router: ReturnType<typeof useRouter>) {
  localStorage.removeItem('accessToken');
  // Autorise la prochaine connexion (même utilisateur ou un autre, sur ce même navigateur) à
  // réévaluer la préférence de langue du compte — cf. language-switcher.tsx.
  localStorage.removeItem('campaignai:localeAccountSynced');
  router.push('/login');
}
