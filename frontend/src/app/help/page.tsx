'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRequireAuth } from '@/lib/use-require-auth';
import { api } from '@/lib/api';
import { Nav } from '@/components/nav';
import { Card, ErrorText } from '@/components/ui';

export default function HelpPage() {
  const ready = useRequireAuth();
  const t = useTranslations('common.help');
  const tErrors = useTranslations('errors');
  const [articles, setArticles] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  function openArticle(slug: string) {
    setError(null);
    api.getHelpArticle(slug).then(setSelected).catch((err: any) => setError(err?.message || tErrors('generic')));
  }

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
            {t('backToHelp')}
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
        <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 16 }}>{t('title')}</h1>
        <input
          placeholder={t('searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border-strong)', fontSize: 14, marginBottom: 20, boxSizing: 'border-box' }}
        />
        <ErrorText message={error} />
        {articles.length === 0 ? (
          <p style={{ fontSize: 13.5, color: 'var(--text-secondary)' }}>{t('noResults')}</p>
        ) : (
          articles.map((a) => (
            <Card key={a.id} style={{ marginBottom: 10, cursor: 'pointer' }}>
              <button
                type="button"
                onClick={() => openArticle(a.slug)}
                style={{ display: 'block', width: '100%', textAlign: 'start', background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer' }}
              >
                <div style={{ fontSize: 14, fontWeight: 600 }}>{a.title}</div>
                {a.category && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{a.category}</div>}
              </button>
            </Card>
          ))
        )}
      </main>
    </>
  );
}
