'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRequireAuth } from '@/lib/use-require-auth';
import { useCurrentUser, canManageTeam } from '@/lib/use-current-user';
import { api } from '@/lib/api';
import { Nav } from '@/components/nav';
import { Card, Button, Field, ErrorText, StatusPill } from '@/components/ui';

const INVITABLE_ROLES = ['ADMIN', 'MARKETING_MANAGER', 'EDITOR', 'VIEWER']; // OWNER ne s'invite jamais, cf. TeamsService

export default function TeamSettingsPage() {
  const ready = useRequireAuth();
  const { user } = useCurrentUser();
  const [members, setMembers] = useState<any[]>([]);
  const [invitations, setInvitations] = useState<any[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('EDITOR');
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  const load = useCallback(() => {
    api.listTeamMembers().then(setMembers).catch((err) => setError(err.message));
    api.listTeamInvitations().then(setInvitations).catch(() => setInvitations([]));
  }, []);

  useEffect(() => { if (ready) load(); }, [ready, load]);

  if (!ready) return null;
  const canManage = canManageTeam(user?.role);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setInviting(true); setError(null);
    try {
      await api.inviteTeamMember({ email, role });
      setEmail('');
      load();
    } catch (err: any) { setError(err.message); }
    finally { setInviting(false); }
  }

  async function changeRole(membershipId: string, newRole: string) {
    setError(null);
    try { await api.changeMemberRole(membershipId, newRole); load(); }
    catch (err: any) { setError(err.message); }
  }

  async function remove(membershipId: string) {
    if (!confirm('Retirer ce membre de l\'organisation ?')) return;
    setError(null);
    try { await api.removeMember(membershipId); load(); }
    catch (err: any) { setError(err.message); }
  }

  async function revoke(invitationId: string) {
    setError(null);
    try { await api.revokeInvitation(invitationId); load(); }
    catch (err: any) { setError(err.message); }
  }

  async function resend(invitationId: string) {
    setError(null);
    try { await api.resendInvitation(invitationId); load(); }
    catch (err: any) { setError(err.message); }
  }

  return (
    <>
      <Nav />
      <main style={{ maxWidth: 720, margin: '40px auto', padding: '0 16px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 24 }}>Équipe</h1>
        <ErrorText message={error} />

        <Card style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 15, fontWeight: 500, marginTop: 0 }}>Membres</h2>
          {members.map((m) => (
            <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderTop: '1px solid #eee' }}>
              <div>
                <div style={{ fontSize: 13.5 }}>{m.user.fullName || m.user.email}</div>
                <div style={{ fontSize: 12, color: '#9a9992' }}>{m.user.email}</div>
              </div>
              {canManage && m.role !== 'OWNER' ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <select
                    value={m.role}
                    onChange={(e) => changeRole(m.id, e.target.value)}
                    style={{ fontSize: 12.5, padding: '5px 8px', borderRadius: 6, border: '1px solid #d8d6cf' }}
                  >
                    {INVITABLE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <button
                    onClick={() => remove(m.id)}
                    style={{ fontSize: 12, background: 'none', border: 'none', color: '#a3352d', cursor: 'pointer' }}
                  >
                    Retirer
                  </button>
                </div>
              ) : (
                <StatusPill status={m.role} />
              )}
            </div>
          ))}
        </Card>

        {invitations.length > 0 && (
          <Card style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 15, fontWeight: 500, marginTop: 0 }}>Invitations en attente</h2>
            {invitations.map((inv) => (
              <div key={inv.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderTop: '1px solid #eee' }}>
                <div>
                  <div style={{ fontSize: 13.5 }}>{inv.email}</div>
                  <div style={{ fontSize: 12, color: '#9a9992' }}>{inv.role}</div>
                </div>
                {canManage && (
                  <div style={{ display: 'flex', gap: 12 }}>
                    <button onClick={() => resend(inv.id)} style={{ fontSize: 12, background: 'none', border: 'none', color: '#5f5e5a', cursor: 'pointer' }}>Renvoyer</button>
                    <button onClick={() => revoke(inv.id)} style={{ fontSize: 12, background: 'none', border: 'none', color: '#a3352d', cursor: 'pointer' }}>Annuler</button>
                  </div>
                )}
              </div>
            ))}
          </Card>
        )}

        {canManage && (
          <Card>
            <h2 style={{ fontSize: 15, fontWeight: 500, marginTop: 0 }}>Inviter un membre</h2>
            <form onSubmit={invite}>
              <Field label="Email" type="email" value={email} onChange={setEmail} required placeholder="collegue@entreprise.com" />
              <label style={{ display: 'block', marginBottom: 16 }}>
                <span style={{ display: 'block', fontSize: 13, marginBottom: 6, color: '#5f5e5a' }}>Rôle</span>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #d8d6cf', fontSize: 14 }}
                >
                  {INVITABLE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
              <Button type="submit" disabled={inviting}>{inviting ? 'Envoi...' : 'Envoyer l\'invitation'}</Button>
            </form>
          </Card>
        )}
      </main>
    </>
  );
}
