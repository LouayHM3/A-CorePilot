import React from 'react';

interface Props {
  onClick: () => void;
  loading: boolean;
  text: string;
  icon?: string;
}

export default function ConnectionTestButton({ onClick, loading, text, icon }: Props) {
  return (
    <button className="btn btn-primary" onClick={onClick} disabled={loading}>
      {loading ? <span className="spinner" /> : (icon && <span>{icon}</span>)}
      {loading ? 'Testing…' : text}
    </button>
  );
}
