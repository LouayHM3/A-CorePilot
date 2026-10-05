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
  callerScanStatus?: 'success' | 'failed' | 'unsupported';
  calleeCount: number;
  impactCount?: number;
  changesLast12Months: number;
  lastChangedDate: string;
  classification?: 'A' | 'B' | 'C' | 'D';
  modType?: string;
  modTypeConfidence?: 'high' | 'medium' | 'low';
  modTypeSource?: string;
  modTypeEvidence?: string;
}

interface ScanProgress {
  current: number;
  total: number;
  objectName: string;
}

type SortKey = keyof Pick<EnrichedObject, 'name' | 'type' | 'packageName' | 'loc' | 'callerCount' | 'calleeCount' | 'impactCount' | 'lastChangedDate' | 'classification' | 'modType'>;
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

function CallerCell({ object }: { object: EnrichedObject }) {
  // A positive legacy count is useful, but a legacy zero was also used for
  // failed/skipped scans and must not be presented as a verified result.
  if (object.callerScanStatus === 'success' || object.callerCount > 0) {
    return <>{object.callerCount}</>;
  }

  const label = object.callerScanStatus === 'unsupported'
    ? 'Not supported'
    : object.callerScanStatus === 'failed'
      ? 'Scan failed'
      : 'Legacy result; re-scan required';
  return <span title={`${label}: caller count is unknown`}>—</span>;
}

function decodeDisplayText(value: string): string {
  let decoded = value ?? '';
  for (let i = 0; i < 3; i++) {
    const next = decoded
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
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

const demoObject = (
  name: string, type: string, packageName: string, description: string,
  loc: number, callerCount: number, calleeCount: number, impactCount: number,
  classification: 'A' | 'B' | 'C' | 'D', lastChangedDate: string,
): EnrichedObject => ({
  name, type, packageName, description, loc, callerCount, calleeCount, impactCount,
  callerScanStatus: 'success', changesLast12Months: Math.max(1, callerCount + calleeCount),
  lastChangedDate, classification, modType: 'CUSTOM_DEVELOPMENT',
  modTypeConfidence: 'high', modTypeSource: 'HISTORICAL_DEMO',
  modTypeEvidence: 'Demonstration data',
});

const DEMO_OBJECTS: EnrichedObject[] = [
  demoObject('ZCL_ORDER_SERVICE', 'CLAS', 'ZCORE_DEMO', 'Order processing service', 428, 5, 4, 9, 'B', '2025-06-18T00:00:00.000Z'),
  demoObject('ZREPORT_ORDER_UI', 'PROG', 'ZCORE_DEMO', 'Order overview report', 286, 0, 5, 6, 'C', '2025-05-02T00:00:00.000Z'),
  demoObject('ZCL_INVOICE_SERVICE', 'CLAS', 'ZFI_DEMO', 'Invoice integration service', 512, 4, 3, 7, 'C', '2025-07-11T00:00:00.000Z'),
  demoObject('ZCL_ORDER_BATCH', 'CLAS', 'ZCORE_DEMO', 'Background order processing', 364, 2, 4, 6, 'B', '2025-03-21T00:00:00.000Z'),
  demoObject('ZORDER_STATUS', 'TABL', 'ZCORE_DEMO', 'Order status persistence', 0, 4, 0, 5, 'A', '2025-01-15T00:00:00.000Z'),
  demoObject('ZCL_CUSTOMER_SERVICE', 'CLAS', 'ZSD_DEMO', 'Customer master facade', 617, 3, 4, 8, 'C', '2025-06-30T00:00:00.000Z'),
  demoObject('ZCL_PRICING_ENGINE', 'CLAS', 'ZSD_DEMO', 'Sales pricing calculation', 742, 6, 3, 10, 'D', '2025-07-04T00:00:00.000Z'),
  demoObject('ZREPORT_SALES_ANALYSIS', 'PROG', 'ZSD_DEMO', 'Sales analytics report', 934, 0, 6, 8, 'C', '2025-04-19T00:00:00.000Z'),
  demoObject('ZSALES_ORDER', 'TABL', 'ZSD_DEMO', 'Sales order persistence', 0, 5, 0, 7, 'B', '2025-02-12T00:00:00.000Z'),
  demoObject('ZIF_PRICING_PROVIDER', 'INTF', 'ZSD_DEMO', 'Pricing provider contract', 118, 2, 0, 4, 'A', '2024-12-03T00:00:00.000Z'),
  demoObject('ZCL_PAYMENT_ADAPTER', 'CLAS', 'ZFI_DEMO', 'Payment gateway adapter', 388, 3, 3, 6, 'C', '2025-05-27T00:00:00.000Z'),
  demoObject('ZFI_POSTING_JOB', 'PROG', 'ZFI_DEMO', 'Finance posting background job', 476, 1, 4, 5, 'B', '2025-03-08T00:00:00.000Z'),
  demoObject('ZFI_DOCUMENT', 'TABL', 'ZFI_DEMO', 'Finance document persistence', 0, 4, 0, 6, 'B', '2025-01-28T00:00:00.000Z'),
  demoObject('ZCL_DELIVERY_TRACKER', 'CLAS', 'ZINT_DEMO', 'Delivery status tracking', 559, 3, 3, 6, 'C', '2025-06-02T00:00:00.000Z'),
  demoObject('ZAPI_ORDER_OUTBOUND', 'CLAS', 'ZINT_DEMO', 'Outbound order API', 831, 2, 5, 8, 'D', '2025-07-09T00:00:00.000Z'),
  demoObject('ZCL_LEGACY_WRAPPER', 'CLAS', 'ZINT_DEMO', 'Legacy integration wrapper', 1068, 2, 3, 7, 'D', '2024-10-14T00:00:00.000Z'),
  demoObject('ZBADI_ORDER_ENRICH', 'CLAS', 'ZCORE_DEMO', 'Order enhancement implementation', 244, 1, 2, 3, 'B', '2025-02-25T00:00:00.000Z'),
  demoObject('ZINVOICE_ARCHIVE', 'TABL', 'ZFI_DEMO', 'Archived invoice records', 0, 2, 0, 3, 'A', '2024-11-20T00:00:00.000Z'),
];

const DEMO_OBJECT_CATALOG: EnrichedObject[] = Array.from({ length: 82 }, (_, index) => {
  const number = String(index + 1).padStart(3, '0');
  const domains = [
    ['CORE', 'ZCORE_DEMO', 'Core order management'],
    ['SALES', 'ZSD_DEMO', 'Sales and distribution'],
    ['FIN', 'ZFI_DEMO', 'Finance and controlling'],
    ['INT', 'ZINT_DEMO', 'Integration services'],
    ['LOG', 'ZLOG_DEMO', 'Logistics operations'],
  ] as const;
  const [prefix, packageName, domainDescription] = domains[index % domains.length];
  const type = ['CLAS', 'PROG', 'TABL', 'INTF', 'FUGR'][index % 5];
  const namePrefix = type === 'CLAS' ? 'ZCL' : type === 'PROG' ? 'ZREPORT' : type === 'TABL' ? 'ZTABLE' : type === 'INTF' ? 'ZIF' : 'ZFG';
  const loc = type === 'TABL' ? 0 : 140 + ((index * 67) % 980);
  const callerCount = 1 + ((index * 3) % 8);
  const calleeCount = type === 'TABL' || type === 'INTF' ? 0 : 1 + ((index * 5) % 6);
  const impactCount = callerCount + calleeCount;
  const classification = impactCount >= 11 ? 'D' : impactCount >= 8 ? 'C' : impactCount >= 4 ? 'B' : 'A';
  const month = String((index % 9) + 1).padStart(2, '0');
  const day = String((index % 27) + 1).padStart(2, '0');
  return demoObject(
    `${namePrefix}_${prefix}_${number}`, type, packageName,
    `${domainDescription} demonstration object ${number}`,
    loc, callerCount, calleeCount, impactCount, classification,
    `2025-${month}-${day}T00:00:00.000Z`,
  );
});

const DEMO_INVENTORY: EnrichedObject[] = [...DEMO_OBJECTS, ...DEMO_OBJECT_CATALOG];

export default function ObjectInventory({ onStartScan }: Props) {
  const [objects, setObjects] = useState<EnrichedObject[]>([]);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [partialPhase, setPartialPhase] = useState<string | null>(null);
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
          setPartialPhase(msg.scanStatus === 'partial' ? (msg.scanPhase ?? 'unknown') : null);
          break;
        case 'scanError':
          setScanning(false);
          setProgress(null);
          setError(msg.message);
          break;
        case 'noScanResults':
          setScanning(false);
          setObjects(DEMO_INVENTORY);
          setScannedAt('2025-07-15T00:00:00.000Z');
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
      {partialPhase && !scanning && (
        <div className="scan-error-banner">
          Partial scan checkpoint ({partialPhase}). Counts may be incomplete; run the scan again.
        </div>
      )}

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
                  ['callerCount', 'Where Used'],
                  ['calleeCount', 'Dependencies'],
                  ['impactCount', 'Total Impact'],
                  ['modType', 'R5 Type'],
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
                    <span className="obj-name" title={decodeDisplayText(obj.description)}>{decodeDisplayText(obj.name)}</span>
                    {obj.description && (
                      <span className="obj-desc">{decodeDisplayText(obj.description)}</span>
                    )}
                  </td>
                  <td><TypePill type={obj.type} /></td>
                  <td><span className="pkg-name">{obj.packageName || '—'}</span></td>
                  <td><LocCell loc={obj.loc} /></td>
                  <td className="num-cell"><CallerCell object={obj} /></td>
                  <td className="num-cell">{obj.calleeCount ?? 0}</td>
                  <td className="num-cell">{obj.impactCount ?? 0}</td>
                  <td title={`${obj.modTypeSource ?? 'DEFAULT'} / ${obj.modTypeConfidence ?? 'low'}: ${obj.modTypeEvidence ?? 'No evidence'}`}>
                    {obj.modType ?? 'CUSTOM_DEVELOPMENT'}
                  </td>
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
