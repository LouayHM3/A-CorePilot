import React, { useEffect, useRef, useState } from 'react';
import SettingsPage from './views/SettingsPage';
import ObjectInventory from './views/ObjectInventory';
import DependencyGraphView from './views/DependencyGraphView';
import PortfolioOverview from './views/PortfolioOverview';
import MigrationPlan from './views/MigrationPlan';
import ReportPreview from './views/ReportPreview';

import { vscode } from './vscodeApi';

type Tab = 'overview' | 'settings' | 'inventory' | 'graph' | 'plan' | 'report';

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [scanProgress, setScanProgress] = useState<{ current: number; total: number; objectName: string } | null>(null);
  const scanReturnTab = useRef<Tab>('inventory');

  // Return to the view that initiated the scan when results are ready.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'scanProgress') {
        setScanProgress({
          current: event.data.current,
          total: event.data.total,
          objectName: event.data.objectName,
        });
      }
      if (event.data?.type === 'scanComplete') {
        setScanProgress(null);
        setActiveTab(scanReturnTab.current);
      }
      if (event.data?.type === 'scanError') {
        setScanProgress(null);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const handleStartScan = (returnTab: Tab) => {
    scanReturnTab.current = returnTab;
    setActiveTab(returnTab);
    vscode.postMessage({ type: 'startScan' });
  };

  return (
    <div className="app">
      {/* ── Tab Bar ── */}
      <div className="tab-bar">
        <div className="tab-bar-logo">
          <img
            src={(window as any).LOGO_URI}
            alt="A-CorePilot"
            style={{ width: 20, height: 20, borderRadius: 4, objectFit: 'contain' }}
          />
          <span className="tab-bar-title">A-CorePilot</span>
        </div>
        <div className="tab-bar-tabs">
          <button className={`tab-btn ${activeTab === 'overview' ? 'tab-btn-active' : ''}`} onClick={() => setActiveTab('overview')}>Overview</button>
          <button
            className={`tab-btn ${activeTab === 'settings' ? 'tab-btn-active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            ⚙ Settings
          </button>
          <button
            className={`tab-btn ${activeTab === 'inventory' ? 'tab-btn-active' : ''}`}
            onClick={() => setActiveTab('inventory')}
          >
            📦 Object Inventory
          </button>
          <button
            className={`tab-btn ${activeTab === 'graph' ? 'tab-btn-active' : ''}`}
            onClick={() => setActiveTab('graph')}
          >
            Dependency Graph
          </button>
          <button className={`tab-btn ${activeTab === 'plan' ? 'tab-btn-active' : ''}`} onClick={() => setActiveTab('plan')}>Migration Plan</button>
          <button className={`tab-btn ${activeTab === 'report' ? 'tab-btn-active' : ''}`} onClick={() => setActiveTab('report')}>Report</button>
        </div>
      </div>

      {/* ── Views ── */}
      {scanProgress && (
        <div className="global-scan-status" role="status">
          <span className="spinner" />
          <span>Scan running: {scanProgress.objectName}</span>
          <span>{scanProgress.current}/{scanProgress.total}</span>
        </div>
      )}

      <div className="tab-content">
        <div style={{ display: activeTab === 'overview' ? 'block' : 'none' }}><PortfolioOverview /></div>
        <div style={{ display: activeTab === 'settings' ? 'block' : 'none' }}><SettingsPage /></div>
        <div style={{ display: activeTab === 'inventory' ? 'block' : 'none' }}><ObjectInventory onStartScan={() => handleStartScan('inventory')} /></div>
        <div style={{ display: activeTab === 'graph' ? 'block' : 'none' }}><DependencyGraphView isActive={activeTab === 'graph'} onStartScan={() => handleStartScan('graph')} /></div>
        <div style={{ display: activeTab === 'plan' ? 'block' : 'none' }}><MigrationPlan /></div>
        <div style={{ display: activeTab === 'report' ? 'block' : 'none' }}><ReportPreview /></div>
      </div>
    </div>
  );
}

export default App;
