import React from 'react';

const risks = [
  ['R1 Coupling', 72, '#f59e0b'],
  ['R2 Complexity', 58, '#f59e0b'],
  ['R3 Integration', 81, '#ef4444'],
  ['R4 Volatility', 37, '#22c55e'],
  ['R5 Modification type', 30, '#22c55e'],
  ['R6 Data sensitivity', 64, '#f59e0b'],
] as const;

const recommendations = [
  ['ZCL_ZAJ_BIAT_RESERVATI_DPC', 'C', '64', 'REWORK', 'Replace non-released Gateway APIs'],
  ['ZCL_ACCESS_PAYMENTS', 'D', '82', 'WRAP', 'Isolate payment access behind a released contract'],
  ['ZCAP_1', 'B', '34', 'KEEP', 'No mandatory remediation detected'],
  ['ZCL_ACORE_DEPENDENCY_SAP', 'B', '41', 'WRAP', 'Existing adapter pattern; document the boundary'],
] as const;

export default function PortfolioOverview() {
  return (
    <div className="demo-page">
      <div className="demo-heading">
        <div>
          <span className="eyebrow">CLEAN CORE ASSESSMENT</span>
          <h1>Migration cockpit</h1>
          <p>Portfolio readiness, technical debt and prioritized actions.</p>
        </div>
        <div className="demo-heading-actions">
          <span className="demo-label">DEMO DATA - UI PROTOTYPE</span>
          <button className="btn btn-secondary" disabled>Export report</button>
        </div>
      </div>

      <div className="metric-grid">
        <article className="metric-card"><span>Custom objects</span><strong>100</strong><small>84 classes, 16 programs</small></article>
        <article className="metric-card"><span>Clean Core ready</span><strong className="tone-good">61%</strong><small>+8% after proposed actions</small></article>
        <article className="metric-card"><span>ATC findings</span><strong className="tone-warn">147</strong><small>12 errors / 46 warnings</small></article>
        <article className="metric-card"><span>Critical objects</span><strong className="tone-bad">7</strong><small>Architect approval required</small></article>
      </div>

      <div className="overview-grid">
        <section className="demo-card risk-card">
          <div className="demo-card-title"><div><h2>Risk profile</h2><p>Weighted score: 61 / 100 - High</p></div><span className="risk-chip high">HIGH</span></div>
          <div className="risk-list">
            {risks.map(([label, value, color]) => (
              <div className="risk-row" key={label}>
                <span>{label}</span><div className="risk-track"><i style={{ width: `${value}%`, background: color }} /></div><b>{value}</b>
              </div>
            ))}
          </div>
          <div className="formula-note">Score = 20% R1 + 20% R2 + 20% R3 + 15% R4 + 15% R5 + 10% R6</div>
        </section>

        <section className="demo-card">
          <div className="demo-card-title"><div><h2>Classification</h2><p>Deterministic mapping from ATC results</p></div></div>
          <div className="class-bars">
            <div><span><b>A</b> Ready</span><i><em style={{ width: '34%' }} /></i><strong>34</strong></div>
            <div><span><b className="class-b">B</b> Minor</span><i><em style={{ width: '27%' }} /></i><strong>27</strong></div>
            <div><span><b className="class-c">C</b> Review</span><i><em style={{ width: '25%' }} /></i><strong>25</strong></div>
            <div><span><b className="class-d">D</b> Critical</span><i><em style={{ width: '14%' }} /></i><strong>14</strong></div>
          </div>
          <div className="advisory"><strong>Decision gate active</strong><span>7 objects require senior review before a migration task can be approved.</span></div>
        </section>
      </div>

      <section className="demo-card recommendation-card">
        <div className="demo-card-title"><div><h2>Priority recommendations</h2><p>Illustrative cloudification actions for report screenshots</p></div><button className="text-button" disabled>View all 24</button></div>
        <table className="demo-table">
          <thead><tr><th>Object</th><th>Class</th><th>Risk</th><th>Decision</th><th>Recommendation</th><th>Status</th></tr></thead>
          <tbody>{recommendations.map(row => <tr key={row[0]}><td className="mono">{row[0]}</td><td><span className={`level level-${row[1].toLowerCase()}`}>{row[1]}</span></td><td>{row[2]}</td><td><span className="decision">{row[3]}</span></td><td>{row[4]}</td><td><span className="status-dot pending" />Proposed</td></tr>)}</tbody>
        </table>
      </section>
    </div>
  );
}
