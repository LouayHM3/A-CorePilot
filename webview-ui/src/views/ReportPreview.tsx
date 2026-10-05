import React from 'react';

export default function ReportPreview() {
  return (
    <div className="demo-page report-page">
      <div className="demo-heading"><div><span className="eyebrow">DELIVERABLE</span><h1>Assessment report</h1><p>Preview of the Clean Core report package.</p></div><div className="demo-heading-actions"><span className="demo-label">PREVIEW ONLY</span><button className="btn btn-primary" disabled>Generate report</button></div></div>
      <div className="report-layout">
        <aside className="report-outline"><h3>Report sections</h3>{['Executive summary','System landscape','Object inventory','ATC assessment','Risk analysis R1-R6','Dependency impact','Cloudification plan','Approval roadmap','Appendices'].map((item, index) => <div className={index === 0 ? 'selected' : ''} key={item}><span>{index + 1}</span>{item}</div>)}</aside>
        <main className="paper-preview">
          <div className="paper-brand"><span>A-COREPILOT</span><small>CLEAN CORE ASSESSMENT</small></div>
          <h1>Executive Summary</h1>
          <p className="lead">The assessment identified a portfolio of 100 custom ABAP objects. The current Clean Core readiness is estimated at 61%, with seven objects requiring architecture approval.</p>
          <div className="paper-kpis"><div><b>61%</b><span>Readiness</span></div><div><b>147</b><span>ATC findings</span></div><div><b>24</b><span>Actions</span></div></div>
          <h2>Key findings</h2>
          <ul><li>Dependency information is based on verified SAP cross-reference results.</li><li>Modification type R5 is classified deterministically from repository evidence.</li><li>High-risk objects pass through a formal decision gate before migration.</li><li>Wrapper patterns are recommended only when a released replacement is unavailable.</li></ul>
          <div className="paper-callout"><strong>Recommended next step</strong><span>Approve Wave 1, resolve priority ATC errors and validate external consumers in the sandbox.</span></div>
          <footer>Generated preview &middot; Demonstration dataset &middot; Page 1 / 12</footer>
        </main>
      </div>
    </div>
  );
}
