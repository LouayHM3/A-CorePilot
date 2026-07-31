import React from 'react';

type Status = 'idle' | 'loading' | 'success' | 'error';

interface Props {
  status: Status;
}

export default function StatusBadge({ status }: Props) {
  if (status === 'idle') return null;

  if (status === 'loading') {
    return (
      <span className="badge badge-loading">
        <span className="spinner" />
        Testing…
      </span>
    );
  }
  if (status === 'success') {
    return <span className="badge badge-success">✓ Connected</span>;
  }
  return <span className="badge badge-error">✗ Failed</span>;
}
