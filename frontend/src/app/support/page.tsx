'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRequireAuth } from '@/lib/use-require-auth';
import { api } from '@/lib/api';
import { Nav } from '@/components/nav';
import { Card, Button, Field, Textarea, StatusPill, ErrorText } from '@/components/ui';

export default function SupportPage() {
  const ready = useRequireAuth();
  const [tickets, setTickets] = useState<any[]>([]);
  const [creating, setCreating] = useState(false);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(() => {
    api.listMyTickets().then(setTickets).catch((err) => setError(err.message));
  }, []);

  useEffect(() => { if (ready) load(); }, [ready, load]);

  if (!ready) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true); setError(null);
    try {
      await api.createTicket({ subject, message });
      setSubject(''); setMessage(''); setCreating(false);
      load();
    } catch (err: any) { setError(err.message); }
    finally { setSubmitting(false); }
  }

  return (
    <>
      <Nav />
      <main style={{ maxWidth: 640, margin: '40px auto', padding: '0 16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <h1 style={{ fontSize: 22, fontWeight: 500, margin: 0 }}>Support</h1>
          {!creating && <Button onClick={() => setCreating(true)}>Nouveau ticket</Button>}
        </div>
        <ErrorText message={error} />

        {creating && (
          <Card style={{ marginBottom: 20 }}>
            <form onSubmit={submit}>
              <Field label="Sujet" value={subject} onChange={setSubject} required />
              <Textarea label="Message" value={message} onChange={setMessage} rows={5} />
              <div style={{ display: 'flex', gap: 10 }}>
                <Button type="submit" disabled={submitting}>{submitting ? 'Envoi...' : 'Envoyer'}</Button>
                <Button variant="secondary" onClick={() => setCreating(false)}>Annuler</Button>
              </div>
            </form>
          </Card>
        )}

        {tickets.length === 0 && !creating ? (
          <Card><p style={{ fontSize: 13.5, color: '#5f5e5a', margin: 0 }}>Aucun ticket pour le moment.</p></Card>
        ) : (
          tickets.map((t) => (
            <Link key={t.id} href={`/support/${t.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <Card style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{t.subject}</span>
                  <StatusPill status={t.status} />
                </div>
              </Card>
            </Link>
          ))
        )}
      </main>
    </>
  );
}
