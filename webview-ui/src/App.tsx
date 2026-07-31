import React, { useEffect, useState } from 'react';
import SettingsPage from './views/SettingsPage';
import ObjectInventory from './views/ObjectInventory';
import DependencyGraphView from './views/DependencyGraphView';

import { vscode } from './vscodeApi';

type Tab = 'settings' | 'inventory' | 'graph';

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('settings');

  // Auto-switch to inventory when scan completes
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'scanComplete') {
        setActiveTab('inventory');
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const handleStartScan = () => {
    setActiveTab('inventory');
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
        </div>
      </div>

      {/* ── Views ── */}
      <div className="tab-content">
        {activeTab === 'settings'   && <SettingsPage />}
        {activeTab === 'inventory'  && <ObjectInventory onStartScan={handleStartScan} />}
        {activeTab === 'graph'      && <DependencyGraphView onStartScan={handleStartScan} />}
      </div>
    </div>
  );
}

export default App;
