import type { Diagnostic } from '@/lib/compiler';

interface DiagPanelProps {
  diagnostics: Diagnostic[];
  loading: boolean;
}

const SEV: Record<string, { color: string; icon: string }> = {
  error:   { color: 'var(--error)',   icon: '✕' },
  warning: { color: 'var(--warning)', icon: '⚠' },
  note:    { color: 'var(--note)',    icon: 'ℹ' },
  help:    { color: 'var(--success)', icon: '?' },
};

export default function DiagPanel({ diagnostics, loading }: DiagPanelProps) {
  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
        Checking…
      </div>
    );
  }

  if (diagnostics.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--text-dim)' }}>
        <span style={{ fontSize: 24, lineHeight: 1 }}>✓</span>
        <span style={{ fontSize: 12, color: 'var(--success)' }}>No issues</span>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '6px 0' }}>
      {diagnostics.map((d, i) => {
        const sev = SEV[d.severity] ?? SEV.error;
        return (
          <div key={i} style={{
            display: 'flex',
            gap: 10,
            padding: '7px 16px',
            borderBottom: '1px solid var(--border-light)',
            lineHeight: 1.5,
          }}>
            {/* Severity icon */}
            <span style={{ color: sev.color, flexShrink: 0, fontSize: 11, marginTop: 2, fontWeight: 700 }}>
              {sev.icon}
            </span>

            {/* Message */}
            <div style={{ flex: 1, minWidth: 0 }}>
              {d.code && (
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: sev.color,
                  background: `color-mix(in srgb, ${sev.color} 12%, transparent)`,
                  borderRadius: 3,
                  padding: '1px 5px',
                  marginRight: 6,
                }}>
                  {d.code}
                </span>
              )}
              <span style={{ fontSize: 12, wordBreak: 'break-word', color: 'var(--text)' }}>
                {d.message}
              </span>
              <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2, fontFamily: 'var(--font-mono)' }}>
                {d.start}–{d.end}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
