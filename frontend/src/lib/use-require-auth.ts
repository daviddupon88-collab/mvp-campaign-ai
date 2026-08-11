'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

// Redirige vers /login si aucun token n'est présent.
// MVP: vérification côté client uniquement — le backend revalide toujours le JWT sur chaque appel API.
export function useRequireAuth() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('accessToken');
    if (!token) {
      router.replace('/login');
    } else {
      setReady(true);
    }
  }, [router]);

  return ready;
}

export function logout(router: ReturnType<typeof useRouter>) {
  localStorage.removeItem('accessToken');
  router.push('/login');
}
