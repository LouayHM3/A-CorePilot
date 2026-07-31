import React from 'react';

type ClassLevel = 'A' | 'B' | 'C' | 'D';

const CLASS_META: Record<ClassLevel, { label: string; color: string; bg: string; title: string }> = {
  A: { label: 'A',  color: '#6bcb6b', bg: 'rgba(107,203,107,0.15)', title: 'Class A (Clean): 0 ATC findings.' },
  B: { label: 'B',  color: '#4db8ff', bg: 'rgba(77,184,255,0.15)',  title: 'Class B (Low): Contains P3 findings (Info), but no P1 or P2.' },
  C: { label: 'C',  color: '#ffb347', bg: 'rgba(255,179,71,0.15)',  title: 'Class C (Medium): Contains P2 findings (Warning), but no P1.' },
  D: { label: 'D',  color: '#ff6b6b', bg: 'rgba(255,107,107,0.15)', title: 'Class D (Critical): Contains at least one P1 finding (Error).' },
};

interface Props {
  level: ClassLevel | undefined;
}

export default function ClassBadge({ level }: Props) {
  if (!level) {
    return (
      <span className="class-badge class-badge-pending" title="Not yet classified">—</span>
    );
  }
  const m = CLASS_META[level];
  return (
    <span
      className="class-badge"
      title={m.title}
      style={{ color: m.color, background: m.bg, borderColor: m.color + '55' }}
    >
      {m.label}
    </span>
  );
}
