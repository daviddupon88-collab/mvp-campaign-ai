'use client';

import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/lib/use-require-auth';
import { api } from '@/lib/api';
import { Nav } from '@/components/nav';
import { Card } from '@/components/ui';

export default function HelpPage() {
  const ready = useRequireAuth();
  const [articles, setArticles] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<any>(null);

  useEffect(() => { api.listHelpArticles().then(setArticles).catch(() => setArticles([])); }, []);

  useEffect(() => {
    if (!query.trim()) { api.listHelpArticles().then(setArticles).catch(() => {}); return; }
    const t = setTimeout(() => api.searchHelpArticles(query).then(setArticles).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [query]);

  if (!ready) return null;

  if (selected) {
    return (
      <>
        <Nav />
        <main style={{ maxWidth: 680, margin: '40px auto', padding: '0 16px' }}>
          <button onClick={() => setSelected(null)} style={{ fontSize: 12.5, background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', marginBottom: 16, padding: 0 }}>
            ← Retour au centre d'aide
          </button>
          <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 16 }}>{selected.title}</h1>
          <div style={{ fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{selected.body}</div>
        </main>
      </>
    );
  }

  return (
    <>
      <Nav />
      <main style={{ maxWidth: 680, margin: '40px auto', padding: '0 16px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 16 }}>Centre d'aide</h1>
        <input
          placeholder="Rechercher..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border-strong)', fontSize: 14, marginBottom: 20, boxSizing: 'border-box' }}
        />
        {articles.length === 0 ? (
          <p style={{ fontSize: 13.5, color: 'var(--text-secondary)' }}>Aucun article ne correspond à votre recherche.</p>
        ) : (
          articles.map((a) => (
            <Card key={a.id} style={{ marginBottom: 10, cursor: 'pointer' }}>
              <div onClick={() => api.getHelpArticle(a.slug).then(setSelected)}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{a.title}</div>
                {a.category && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{a.category}</div>}
              </div>
            </Card>
          ))
        )}
      </main>
    </>
  );
}
