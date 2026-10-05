import React, { useState } from 'react';

type PlanStatus = 'Proposed' | 'Approved' | 'Deferred';

const initialTasks = [
  { id: 1, object: 'ZCL_ACCESS_PAYMENTS', title: 'Introduce released payment interface', owner: 'ABAP Team', effort: '8 d', status: 'Proposed' as PlanStatus },
  { id: 2, object: 'ZCL_ZAJ_BIAT_RESERVATI_DPC', title: 'Replace unreleased Gateway references', owner: 'S/4 Team', effort: '5 d', status: 'Proposed' as PlanStatus },
  { id: 3, object: 'ZCAP_1', title: 'Retest with ABAP Cloud ATC variant', owner: 'Quality', effort: '1 d', status: 'Approved' as PlanStatus },
  { id: 4, object: 'ZCL_ACORE_DEPENDENCY_SAP', title: 'Document wrapper exception', owner: 'Architecture', effort: '2 d', status: 'Deferred' as PlanStatus },
];

export default function MigrationPlan() {
  const [tasks, setTasks] = useState(initialTasks);
  const update = (id: number, status: PlanStatus) => setTasks(items => items.map(item => item.id === id ? { ...item, status } : item));

  return (
    <div className="demo-page">
      <div className="demo-heading">
        <div><span className="eyebrow">MIGRATION GOVERNANCE</span><h1>Clean Core migration plan</h1><p>Review work packages and simulate the approval workflow.</p></div>
        <span className="demo-label">DEMO DATA - LOCAL UI ONLY</span>
      </div>
      <div className="plan-summary">
        <div><span>Planned effort</span><strong>16 days</strong></div><div><span>Approved</span><strong>{tasks.filter(t => t.status === 'Approved').length} / {tasks.length}</strong></div><div><span>Target release</span><strong>S/4HANA 2023</strong></div><div><span>Wave</span><strong>Foundation - W1</strong></div>
      </div>
      <div className="workflow-strip"><span className="done">Inventory</span><i /><span className="done">Assessment</span><i /><span className="active">Approval</span><i /><span>Implementation</span><i /><span>Validation</span></div>
      <section className="demo-card">
        <div className="demo-card-title"><div><h2>Work packages</h2><p>Buttons below change display state only and do not modify SAP.</p></div><button className="btn btn-primary" disabled>Create work package</button></div>
        <div className="task-list">
          {tasks.map(task => (
            <article className="task-row" key={task.id}>
              <div className="task-order">{String(task.id).padStart(2, '0')}</div>
              <div className="task-main"><span className="mono">{task.object}</span><strong>{task.title}</strong><small>{task.owner} &middot; Estimated effort {task.effort}</small></div>
              <span className={`plan-status ${task.status.toLowerCase()}`}>{task.status}</span>
              <div className="task-actions"><button onClick={() => update(task.id, 'Approved')}>Approve</button><button onClick={() => update(task.id, 'Deferred')}>Defer</button></div>
            </article>
          ))}
        </div>
      </section>
      <div className="demo-disclaimer"><strong>Prototype boundary:</strong> approval changes are intentionally not persisted and no code, transport or SAP object is created.</div>
    </div>
  );
}
