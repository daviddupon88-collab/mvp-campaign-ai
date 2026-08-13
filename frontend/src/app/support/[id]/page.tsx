'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations, useLocale } from 'next-intl';
import { useRequireAuth } from '@/lib/use-require-auth';
import { api } from '@/lib/api';
import { Nav } from '@/components/nav';
import { Card, Button, Textarea, StatusPill, ErrorText } from '@/components/ui';
import { INTL_TAGS, Locale } from '@/i18n/config';

export default function TicketDetailPage() {
  const ready = useRequireAuth();
  const params = useParams();
  const ticketId = params.id as string;
  const t = useTranslations('common.support');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const intlTag = INTL_TAGS[locale as Locale] ?? 'en-US';

  const [ticket, setTicket] = useState<any>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const load = useCallback(() => {
    api.getTicket(ticketId).then(setTicket).catch((err) => setError(err.message));
  }, [ticketId]);

  useEffect(() => { if (ready) load(); }, [ready, load]);

  if (!ready || !ticket) return null;

  async function sendReply(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim()) return;
    setSending(true); setError(null);
    try {
      await api.replyTicket(ticketId, message);
      setMessage('');
      load();
    } catch (err: any) { setError(err.message); }
    finally { setSending(false); }
  }

  const isClosed = ticket.status === 'RESOLVED' || ticket.status === 'CLOSED';

  return (
    <>
      <Nav />
      <main style={{ maxWidth: 640, margin: '40px auto', padding: '0 16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <h1 style={{ fontSize: 20, fontWeight: 500, margin: 0 }}>{ticket.subject}</h1>
          <StatusPill status={ticket.status} />
        </div>

        <ErrorText message={error} />

        {/* Message initial */}
        <Card style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
            {ticket.user?.email} · {new Date(ticket.createdAt).toLocaleString(intlTag)}
          </div>
          <div style={{ fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{ticket.message}</div>
        </Card>

        {/* Fil de conversation — isStaff distingue une réponse de l'équipe Campaign-ai
            d'une réponse du client, cf. SupportTicketReply côté backend. */}
        {ticket.replies?.map((r: any) => (
          <Card
            key={r.id}
            style={{
              marginBottom: 12,
              background: r.isStaff ? 'var(--bg-raised)' : 'var(--bg-panel)',
              marginInlineStart: r.isStaff ? 0 : 24,
              marginInlineEnd: r.isStaff ? 24 : 0,
            }}
          >
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
              {r.isStaff ? t('team') : t('you')} · {new Date(r.createdAt).toLocaleString(intlTag)}
            </div>
            <div style={{ fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{r.message}</div>
          </Card>
        ))}

        {isClosed ? (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', marginTop: 20 }}>
            {ticket.status === 'RESOLVED' ? t('ticketClosedResolved') : t('ticketClosedClosed')}
          </p>
        ) : null}

        <Card style={{ marginTop: 20 }}>
          <form onSubmit={sendReply}>
            <Textarea value={message} onChange={setMessage} rows={4} placeholder={t('replyPlaceholder')} />
            <Button type="submit" disabled={sending || !message.trim()}>
              {sending ? tCommon('status.sending') : tCommon('actions.reply')}
            </Button>
          </form>
        </Card>
      </main>
    </>
  );
}
