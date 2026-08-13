import React from 'react';
import { useTranslations } from 'next-intl';

export function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        background: 'var(--bg-panel)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: 24,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Button({
  children,
  type = 'button',
  onClick,
  disabled,
  variant = 'primary',
}: {
  children: React.ReactNode;
  type?: 'button' | 'submit';
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
}) {
  const primary = variant === 'primary';
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '10px 18px',
        borderRadius: 9,
        border: primary ? 'none' : '1px solid var(--border-strong)',
        background: primary ? 'var(--accent-brand)' : 'transparent',
        color: primary ? 'var(--bg-page)' : 'var(--text-primary)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        fontSize: 14,
        fontWeight: 600,
      }}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  type = 'text',
  value,
  onChange,
  required,
  placeholder,
}: {
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <label style={{ display: 'block', marginBottom: 16 }}>
      <span style={{ display: 'block', fontSize: 13, marginBottom: 6, color: 'var(--text-secondary)' }}>{label}</span>
      <input
        type={type}
        value={value}
        required={required}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%',
          padding: '10px 12px',
          borderRadius: 8,
          border: '1px solid var(--border)',
          background: 'var(--bg-page)',
          color: 'var(--text-primary)',
          fontSize: 14,
          boxSizing: 'border-box',
        }}
      />
    </label>
  );
}

// role="alert" annonce le message aux lecteurs d'écran dès son insertion, sans action de
// l'utilisateur. Le déplacement du focus clavier (tabIndex + focus() au montage) est un
// second garde-fou complémentaire : sans lui, un utilisateur au clavier qui vient de soumettre
// un formulaire en échec n'a aucune indication qu'une erreur est apparue — il doit la
// découvrir par hasard en retabulant dans la page. Utilisé après CHAQUE échec de soumission
// dans l'application (login, register, campagnes, paramètres...).
export function ErrorText({ message }: { message: string | null }) {
  const ref = React.useRef<HTMLParagraphElement>(null);

  React.useEffect(() => {
    if (message) ref.current?.focus();
  }, [message]);

  if (!message) return null;
  return (
    <p ref={ref} role="alert" tabIndex={-1} style={{ color: 'var(--accent-danger)', fontSize: 13, marginTop: -8, marginBottom: 16 }}>
      {message}
    </p>
  );
}

export function Textarea({
  label,
  value,
  onChange,
  rows = 4,
  placeholder,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <label style={{ display: 'block', marginBottom: 16 }}>
      {label && <span style={{ display: 'block', fontSize: 13, marginBottom: 6, color: 'var(--text-secondary)' }}>{label}</span>}
      <textarea
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%',
          padding: '10px 12px',
          borderRadius: 8,
          border: '1px solid var(--border)',
          background: 'var(--bg-page)',
          color: 'var(--text-primary)',
          fontSize: 14,
          boxSizing: 'border-box',
          fontFamily: 'inherit',
          resize: 'vertical',
        }}
      />
    </label>
  );
}

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  PASSED: { bg: 'var(--accent-done-dim)', fg: 'var(--accent-done)' },
  DONE: { bg: 'var(--accent-done-dim)', fg: 'var(--accent-done)' },
  APPROVED: { bg: 'var(--accent-done-dim)', fg: 'var(--accent-done)' },
  PUBLISHED: { bg: 'var(--accent-done-dim)', fg: 'var(--accent-done)' },
  ACTIVE: { bg: 'var(--accent-done-dim)', fg: 'var(--accent-done)' },
  RESOLVED: { bg: 'var(--accent-done-dim)', fg: 'var(--accent-done)' },
  FLAGGED: { bg: 'var(--accent-signal-dim)', fg: 'var(--accent-signal)' },
  PENDING: { bg: 'var(--accent-signal-dim)', fg: 'var(--accent-signal)' },
  READY_FOR_REVIEW: { bg: 'var(--accent-signal-dim)', fg: 'var(--accent-signal)' },
  IN_PROGRESS: { bg: 'var(--accent-signal-dim)', fg: 'var(--accent-signal)' },
  OPEN: { bg: 'var(--accent-signal-dim)', fg: 'var(--accent-signal)' },
  SCHEDULED: { bg: 'var(--accent-brand-dim)', fg: 'var(--accent-brand)' },
  BLOCKED: { bg: 'var(--accent-danger-dim)', fg: 'var(--accent-danger)' },
  REJECTED: { bg: 'var(--accent-danger-dim)', fg: 'var(--accent-danger)' },
  FAILED: { bg: 'var(--accent-danger-dim)', fg: 'var(--accent-danger)' },
  SUSPENDED: { bg: 'var(--accent-danger-dim)', fg: 'var(--accent-danger)' },
  APPLIED: { bg: 'var(--accent-done-dim)', fg: 'var(--accent-done)' },
  DISMISSED: { bg: 'var(--bg-raised)', fg: 'var(--text-muted)' },
};

export function StatusPill({ status }: { status: string }) {
  const t = useTranslations('common.statusLabels');
  const c = STATUS_COLORS[status] ?? { bg: 'var(--bg-raised)', fg: 'var(--text-secondary)' };
  // Statuts inconnus (rôles, valeurs métier non listées dans common.statusLabels) : on
  // retombe sur la donnée brute plutôt que d'afficher une clé de traduction manquante.
  const label = t.has(status) ? t(status) : status.replace(/_/g, ' ');
  return (
    <span
      className="mono"
      style={{
        fontSize: 11.5,
        fontWeight: 600,
        padding: '3px 9px',
        borderRadius: 20,
        background: c.bg,
        color: c.fg,
        textTransform: 'lowercase',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

export function ScoreBar({ label, value, max = 100 }: { label: string; value: number; max?: number }) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
        <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
        <span className="mono">{value}/{max}</span>
      </div>
      <div style={{ height: 6, background: 'var(--border)', borderRadius: 6, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: pct > 90 ? 'var(--accent-danger)' : 'var(--accent-brand)', borderRadius: 6 }} />
      </div>
    </div>
  );
}

type TabItem = string | { key: string; label: string };

function tabKey(t: TabItem): string {
  return typeof t === 'string' ? t : t.key;
}
function tabLabel(t: TabItem): string {
  return typeof t === 'string' ? t : t.label;
}

// tabs accepte soit des chaînes brutes (clé = libellé affiché, historique), soit des objets
// {key, label} — nécessaire dès que le libellé affiché est traduit et ne peut donc plus
// servir de valeur stable pour l'état actif (cf. campaigns/[id] et admin, qui utilisent des
// clés internes en anglais indépendantes de la langue de l'interface).
export function Tabs({ tabs, active, onChange }: { tabs: TabItem[]; active: string; onChange: (t: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 20 }}>
      {tabs.map((t) => (
        <button
          key={tabKey(t)}
          onClick={() => onChange(tabKey(t))}
          style={{
            padding: '10px 14px',
            fontSize: 13.5,
            fontWeight: active === tabKey(t) ? 600 : 400,
            background: 'none',
            border: 'none',
            borderBottom: active === tabKey(t) ? '2px solid var(--accent-brand)' : '2px solid transparent',
            color: active === tabKey(t) ? 'var(--text-primary)' : 'var(--text-secondary)',
            cursor: 'pointer',
            marginBottom: -1,
          }}
        >
          {tabLabel(t)}
        </button>
      ))}
    </div>
  );
}
