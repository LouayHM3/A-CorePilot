import React, { useEffect, useState } from 'react';
import ConnectionTestButton from '../components/ConnectionTestButton';
import StatusBadge from '../components/StatusBadge';

import { vscode } from '../vscodeApi';

type Status = 'idle' | 'loading' | 'success' | 'error';

/** Sentinel shown in password fields when a secret already exists in keychain */
const SECRET_PLACEHOLDER = '••••••••';

interface Settings {
  sapHost: string;
  sapClient: string;
  sapUsername: string;
  sapTargetRelease: string;
  sapPassword: string;
  aiTokenUrl: string;
  aiClientId: string;
  aiApiBase: string;
  aiDeploymentId: string;
  aiResourceGroup: string;
  aiClientSecret: string;
  sapAtcVariant: string;
}

const DEFAULTS: Settings = {
  sapHost: '', sapClient: '100', sapUsername: '',
  sapTargetRelease: '2023', sapPassword: '',
  aiTokenUrl: '', aiClientId: '', aiApiBase: '',
  aiDeploymentId: '', aiResourceGroup: 'default', aiClientSecret: '',
  sapAtcVariant: 'ZABAP_CLOUD_DEV_DEFAULT'
};

// Maps config key names to VS Code setting paths
const CONFIG_KEY_MAP: Record<string, string> = {
  sapHost: 'sap.host',
  sapClient: 'sap.client',
  sapUsername: 'sap.username',
  sapTargetRelease: 'sap.targetRelease',
  aiTokenUrl: 'aicore.tokenUrl',
  aiClientId: 'aicore.clientId',
  aiApiBase: 'aicore.apiBase',
  aiDeploymentId: 'aicore.deploymentId',
  aiResourceGroup: 'aicore.resourceGroup',
  sapAtcVariant: 'sap.atcVariant',
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [sapStatus, setSapStatus] = useState<Status>('idle');
  const [aiStatus, setAiStatus] = useState<Status>('idle');
  // Track whether each secret already exists in the keychain
  const [sapPasswordSet, setSapPasswordSet] = useState(false);
  const [aiSecretSet, setAiSecretSet] = useState(false);

  useEffect(() => {
    vscode.postMessage({ type: 'getSettings' });
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'settingsConfig') {
        setSapPasswordSet(!!msg.sapPasswordSet);
        setAiSecretSet(!!msg.aiSecretSet);
        setSettings(s => ({ ...s, ...msg.settings }));
      }
      if (msg.type === 'sapConnectionResult') setSapStatus(msg.ok ? 'success' : 'error');
      if (msg.type === 'aiCoreConnectionResult') setAiStatus(msg.ok ? 'success' : 'error');
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const update = (key: keyof Settings, value: string) => {
    setSettings(s => ({ ...s, [key]: value }));
    if (key === 'sapPassword') {
      // Only forward to keychain when the user typed a real new value
      if (value && value !== SECRET_PLACEHOLDER) {
        setSapPasswordSet(true);
        vscode.postMessage({ type: 'saveSapPassword', value });
      }
    } else if (key === 'aiClientSecret') {
      if (value && value !== SECRET_PLACEHOLDER) {
        setAiSecretSet(true);
        vscode.postMessage({ type: 'saveAiCoreSecret', value });
      }
    } else if (CONFIG_KEY_MAP[key]) {
      vscode.postMessage({ type: 'updateConfig', key: CONFIG_KEY_MAP[key], value });
    }
  };

  const testSap = () => { setSapStatus('loading'); vscode.postMessage({ type: 'testSapConnection' }); };
  const testAi = () => { setAiStatus('loading'); vscode.postMessage({ type: 'testAiCoreConnection' }); };

  return (
    <div className="settings-page">
      <div className="settings-page-heading">
        <h2>Connection Settings</h2>
        <p>Configure your SAP system and SAP AI Core credentials. Secrets are stored in the OS keychain — never written to disk.</p>
      </div>

      <div className="content">
        {/* ── SAP System ── */}
        <div className="section-card">
          <div className="section-header">
            <span className="section-icon">🔗</span>
            <h2>SAP System</h2>
          </div>

          <div className="section-body">
            {/* Row 1 */}
            <div className="field full-width">
              <label>SAP Host URL</label>
              <input
                type="text"
                value={settings.sapHost}
                onChange={e => update('sapHost', e.target.value)}
                placeholder="https://your-sap-host:44300"
              />
            </div>

            {/* Row 2 */}
            <div className="field">
              <label>SAP Client</label>
              <input
                type="text"
                value={settings.sapClient}
                onChange={e => update('sapClient', e.target.value)}
                placeholder="100"
              />
            </div>
            <div className="field">
              <label>Target S/4HANA Release</label>
              <input
                type="text"
                value={settings.sapTargetRelease}
                onChange={e => update('sapTargetRelease', e.target.value)}
                placeholder="2025"
              />
            </div>
            <div className="field">
              <label>Custom ATC Variant</label>
              <input
                type="text"
                value={settings.sapAtcVariant}
                onChange={e => update('sapAtcVariant', e.target.value)}
                placeholder="ZABAP_CLOUD_DEV_DEFAULT"
              />
            </div>

            {/* Row 3 */}
            <div className="field">
              <label>Username</label>
              <input
                type="text"
                value={settings.sapUsername}
                onChange={e => update('sapUsername', e.target.value)}
                placeholder="ABAP_USER"
              />
            </div>
            <div className="field">
              <label>Password</label>
              <input
                type="password"
                value={settings.sapPassword}
                onChange={e => update('sapPassword', e.target.value)}
                placeholder={sapPasswordSet ? SECRET_PLACEHOLDER : 'Enter password…'}
              />
              <span className="secure-hint">🔒 {sapPasswordSet ? 'Saved in OS keychain' : 'Never written to disk'}</span>
            </div>
          </div>

          <div className="section-footer">
            <ConnectionTestButton onClick={testSap} loading={sapStatus === 'loading'} text="Test SAP Connection" icon="⚡" />
            <StatusBadge status={sapStatus} />
          </div>
        </div>

        {/* ── SAP AI Core ── */}
        <div className="section-card">
          <div className="section-header">
            <span className="section-icon">🤖</span>
            <h2>SAP AI Core (BTP)</h2>
          </div>

          <div className="section-body">
            {/* Row 1 */}
            <div className="field full-width">
              <label>OAuth Token URL</label>
              <input
                type="text"
                value={settings.aiTokenUrl}
                onChange={e => update('aiTokenUrl', e.target.value)}
                placeholder="https://<subaccount>.authentication.eu10.hana.ondemand.com/oauth/token"
              />
            </div>

            {/* Row 2 */}
            <div className="field">
              <label>Client ID</label>
              <input
                type="text"
                value={settings.aiClientId}
                onChange={e => update('aiClientId', e.target.value)}
                placeholder="sb-..."
              />
            </div>
            <div className="field">
              <label>Client Secret</label>
              <input
                type="password"
                value={settings.aiClientSecret}
                onChange={e => update('aiClientSecret', e.target.value)}
                placeholder={aiSecretSet ? SECRET_PLACEHOLDER : 'Enter secret…'}
              />
              <span className="secure-hint">🔒 {aiSecretSet ? 'Saved in OS keychain' : 'Never written to disk'}</span>
            </div>

            {/* Row 3 */}
            <div className="field full-width">
              <label>API Base URL</label>
              <input
                type="text"
                value={settings.aiApiBase}
                onChange={e => update('aiApiBase', e.target.value)}
                placeholder="https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com"
              />
            </div>

            {/* Row 4 */}
            <div className="field">
              <label>Deployment ID</label>
              <input
                type="text"
                value={settings.aiDeploymentId}
                onChange={e => update('aiDeploymentId', e.target.value)}
                placeholder="d1234abcd"
              />
            </div>
            <div className="field">
              <label>Resource Group</label>
              <input
                type="text"
                value={settings.aiResourceGroup}
                onChange={e => update('aiResourceGroup', e.target.value)}
                placeholder="default"
              />
            </div>
          </div>

          <div className="section-footer">
            <ConnectionTestButton onClick={testAi} loading={aiStatus === 'loading'} text="Test AI Core Connection" icon="⚡" />
            <StatusBadge status={aiStatus} />
          </div>
        </div>
      </div>
    </div>
  );
}
