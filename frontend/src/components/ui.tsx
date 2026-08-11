import React from 'react';

export function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid #e5e3dd',
        borderRadius: 12,
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
        borderRadius: 8,
        border: primary ? 'none' : '1px solid #d8d6cf',
        background: primary ? '#1a1a18' : 'transparent',
        color: primary ? '#fff' : '#1a1a18',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        fontSize: 14,
        fontWeight: 500,
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
      <span style={{ display: 'block', fontSize: 13, marginBottom: 6, color: '#5f5e5a' }}>{label}</span>
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
          border: '1px solid #d8d6cf',
          fontSize: 14,
          boxSizing: 'border-box',
        }}
      />
    </label>
  );
}

export function ErrorText({ message }: { message: string | null }) {
  if (!message) return null;
  return <p style={{ color: '#a32d2d', fontSize: 13, marginTop: -8, marginBottom: 16 }}>{message}</p>;
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
      {label && <span style={{ display: 'block', fontSize: 13, marginBottom: 6, color: '#5f5e5a' }}>{label}</span>}
      <textarea
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%',
          padding: '10px 12px',
          borderRadius: 8,
          border: '1px solid #d8d6cf',
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
  PASSED: { bg: '#eaf5ef', fg: '#2d6b4f' },
  DONE: { bg: '#eaf5ef', fg: '#2d6b4f' },
  APPROVED: { bg: '#eaf5ef', fg: '#2d6b4f' },
  PUBLISHED: { bg: '#eaf5ef', fg: '#2d6b4f' },
  ACTIVE: { bg: '#eaf5ef', fg: '#2d6b4f' },
  RESOLVED: { bg: '#eaf5ef', fg: '#2d6b4f' },
  FLAGGED: { bg: '#fdf3e3', fg: '#8a6414' },
  PENDING: { bg: '#fdf3e3', fg: '#8a6414' },
  READY_FOR_REVIEW: { bg: '#fdf3e3', fg: '#8a6414' },
  IN_PROGRESS: { bg: '#fdf3e3', fg: '#8a6414' },
  OPEN: { bg: '#fdf3e3', fg: '#8a6414' },
  SCHEDULED: { bg: '#eef0fb', fg: '#3d4a9e' },
  BLOCKED: { bg: '#fdeeee', fg: '#a3352d' },
  REJECTED: { bg: '#fdeeee', fg: '#a3352d' },
  FAILED: { bg: '#fdeeee', fg: '#a3352d' },
  SUSPENDED: { bg: '#fdeeee', fg: '#a3352d' },
  APPLIED: { bg: '#eaf5ef', fg: '#2d6b4f' },
  DISMISSED: { bg: '#f1f0ec', fg: '#8a8880' },
};

export function StatusPill({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? { bg: '#f1f0ec', fg: '#5f5e5a' };
  return (
    <span
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
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export function ScoreBar({ label, value, max = 100 }: { label: string; value: number; max?: number }) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
        <span style={{ color: '#5f5e5a' }}>{label}</span>
        <span className="mono">{value}/{max}</span>
      </div>
      <div style={{ height: 6, background: '#eee', borderRadius: 6, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: pct > 90 ? '#a3552d' : '#1a1a18', borderRadius: 6 }} />
      </div>
    </div>
  );
}

export function Tabs({ tabs, active, onChange }: { tabs: string[]; active: string; onChange: (t: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e5e3dd', marginBottom: 20 }}>
      {tabs.map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          style={{
            padding: '10px 14px',
            fontSize: 13.5,
            fontWeight: active === t ? 600 : 400,
            background: 'none',
            border: 'none',
            borderBottom: active === t ? '2px solid #1a1a18' : '2px solid transparent',
            color: active === t ? '#1a1a18' : '#5f5e5a',
            cursor: 'pointer',
            marginBottom: -1,
          }}
        >
          {t}
        </button>
      ))}
    </div>
  );
}
