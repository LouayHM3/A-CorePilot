import React, { useEffect, useState, useMemo } from 'react';
import ClassBadge from '../components/ClassBadge';

import { vscode } from '../vscodeApi';

// ── Types ────────────────────────────────────────────────────────────────────

interface EnrichedObject {
  name: string;
  type: string;
  packageName: string;
  description: string;
  loc: number;
  callerCount: number;
  changesLast12Months: number;
  lastChangedDate: string;
  classification?: 'A' | 'B' | 'C' | 'D';
}

interface ScanProgress {
  current: number;
  total: number;
  objectName: string;
}

type SortKey = keyof Pick<EnrichedObject, 'name' | 'type' | 'packageName' | 'loc' | 'callerCount' | 'lastChangedDate' | 'classification'>;
type SortDir = 'asc' | 'desc';

// ── Helpers ──────────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  PROG: '#7c9ef5', CLAS: '#c792ea', FUGR: '#89ddff',
  INTF: '#82aaff', TABL: '#f78c6c', DTEL: '#ffcb6b',
  DOMA: '#c3e88d', MSAG: '#ff5572',
};

function TypePill({ type }: { type: string }) {
  const color = TYPE_COLORS[type] ?? '#888';
  return (
    <span className="type-pill" style={{ color, borderColor: color + '55', background: color + '18' }}>
      {type}
    </span>
  );
}

function LocCell({ loc }: { loc: number }) {
  const cls = loc > 500 ? 'loc-high' : loc > 100 ? 'loc-med' : 'loc-low';
  return <span className={`loc-val ${cls}`}>{loc > 0 ? loc.toLocaleString() : '—'}</span>;
}

function relativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days < 1) return 'today';
  if (days < 7) return `${days}d ago`;
  if (days < 31) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <span className="sort-icon sort-idle">⇅</span>;
  return <span className="sort-icon sort-active">{dir === 'asc' ? '↑' : '↓'}</span>;
}

// ── ObjectInventory ───────────────────────────────────────────────────────────

interface Props {
  onStartScan: () => void;
}

export default function ObjectInventory({ onStartScan }: Props) {
  const [objects, setObjects] = useState<EnrichedObject[]>([]);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // ── Message bus ─────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      switch (msg.type) {
        case 'scanProgress':
          setScanning(true);
          setError(null);
          setProgress({ current: msg.current, total: msg.total, objectName: msg.objectName });
          break;
        case 'scanComplete':
          setScanning(false);
          setProgress(null);
          setObjects(msg.objects ?? []);
          setScannedAt(msg.scannedAt ?? new Date().toISOString());
          break;
        case 'scanError':
          setScanning(false);
          setProgress(null);
          setError(msg.message);
          break;
        case 'noScanResults':
          setScanning(false);
          break;
      }
    };
    window.addEventListener('message', handler);
    // Ask extension to load cached results on mount
    vscode.postMessage({ type: 'loadScanResults' });
    return () => window.removeEventListener('message', handler);
  }, []);

  // ── Sort & filter ────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = filter.toLowerCase();
    return objects.filter(o =>
      o.name.toLowerCase().includes(q) ||
      o.packageName.toLowerCase().includes(q) ||
      o.type.toLowerCase().includes(q) ||
      (o.description ?? '').toLowerCase().includes(q)
    );
  }, [objects, filter]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let av: string | number = a[sortKey] ?? '';
      let bv: string | number = b[sortKey] ?? '';
      if (typeof av === 'string') av = av.toLowerCase();
      if (typeof bv === 'string') bv = bv.toLowerCase();
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }, [filtered, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const handleScan = () => {
    setScanning(true);
    setError(null);
    setObjects([]);
    setProgress(null);
    onStartScan();
  };

  // ── Progress % ───────────────────────────────────────────────────────────
  const progressPct = progress
    ? Math.round((progress.current / Math.max(progress.total, 1)) * 100)
    : 0;

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="inventory-root">

      {/* ── Toolbar ── */}
      <div className="inventory-toolbar">
        <div className="inventory-toolbar-left">
          {objects.length > 0 && (
            <span className="inventory-count">
              {sorted.length} / {objects.length} objects
              {scannedAt && (
                <span className="inventory-scanned-at"> · scanned {relativeDate(scannedAt)}</span>
              )}
            </span>
          )}
        </div>
        <div className="inventory-toolbar-right">
          {objects.length > 0 && (
            <input
              className="inventory-search"
              type="text"
              placeholder="Filter by name, package, type…"
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
          )}
          <button
            className={`btn ${scanning ? 'btn-secondary' : 'btn-primary'}`}
            onClick={handleScan}
            disabled={scanning}
          >
            {scanning ? <span className="spinner" /> : <span>⟳</span>}
            {scanning ? 'Scanning…' : objects.length > 0 ? 'Re-scan' : 'Start Scan'}
          </button>
        </div>
      </div>

      {/* ── Progress bar ── */}
      {scanning && (
        <div className="scan-progress-wrap">
          <div className="scan-progress-bar" style={{ width: `${progressPct}%` }} />
          <div className="scan-progress-label">
            {progress
              ? `[${progress.current}/${progress.total}] ${progress.objectName}`
              : 'Connecting to SAP…'}
          </div>
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="scan-error-banner">
          <span>⚠</span> {error}
        </div>
      )}

      {/* ── Empty state ── */}
      {!scanning && objects.length === 0 && !error && (
        <div className="inventory-empty">
          <div className="inventory-empty-icon">🔍</div>
          <h2>No objects scanned yet</h2>
          <p>Click <strong>Start Scan</strong> to connect to your SAP system and discover all Z*/Y* custom objects.</p>
          <p className="inventory-empty-hint">Make sure your SAP connection is configured in the <strong>Settings</strong> tab first.</p>
        </div>
      )}

      {/* ── Table ── */}
      {objects.length > 0 && (
        <div className="inventory-table-wrap">
          <table className="inventory-table">
            <thead>
              <tr>
                {([
                  ['name', 'Object Name'],
                  ['type', 'Type'],
                  ['packageName', 'Package'],
                  ['loc', 'LOC'],
                  ['callerCount', 'Callers'],
                  ['lastChangedDate', 'Last Changed'],
                  ['classification', 'Class.'],
                ] as [SortKey, string][]).map(([key, label]) => (
                  <th key={key} onClick={() => toggleSort(key)} className="sortable-th">
                    {label}
                    <SortIcon active={sortKey === key} dir={sortDir} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map(obj => (
                <tr key={`${obj.type}::${obj.name}`} className="inventory-row">
                  <td>
                    <span className="obj-name" title={obj.description}>{obj.name}</span>
                    {obj.description && (
                      <span className="obj-desc">{obj.description}</span>
                    )}
                  </td>
                  <td><TypePill type={obj.type} /></td>
                  <td><span className="pkg-name">{obj.packageName || '—'}</span></td>
                  <td><LocCell loc={obj.loc} /></td>
                  <td className="num-cell">{obj.callerCount}</td>
                  <td className="date-cell" title={obj.lastChangedDate}>
                    {obj.lastChangedDate ? relativeDate(obj.lastChangedDate) : '—'}
                  </td>
                  <td><ClassBadge level={obj.classification} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
