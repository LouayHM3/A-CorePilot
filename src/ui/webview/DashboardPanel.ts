import * as vscode from 'vscode';
import { SecretStorageService } from '../../services/SecretStorageService';
import { SettingsService } from '../../services/SettingsService';
import { ScannerAgent } from '../../agents/ScannerAgent';
import { EnrichedObject } from '../../sap/ObjectDiscovery';
import { SidebarProvider } from '../sidebar/SidebarProvider';

export class DashboardPanel {
  static currentPanel: DashboardPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  static createOrShow(
    extensionUri: vscode.Uri,
    secrets: SecretStorageService,
    sidebar: SidebarProvider
  ): void {
    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'corepilotDashboard',
      'A-CorePilot Dashboard',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'dist', 'webview'),
          vscode.Uri.joinPath(extensionUri, 'resources'),
        ],
      }
    );
    DashboardPanel.currentPanel = new DashboardPanel(panel, extensionUri, secrets, sidebar);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private extensionUri: vscode.Uri,
    private secrets: SecretStorageService,
    private sidebar: SidebarProvider
  ) {
    this._panel = panel;
    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.type) {

          // ── Settings ────────────────────────────────────────────────────
          case 'saveSapPassword':
            // Guard: never store the UI placeholder string into the keychain
            if (message.value && message.value !== '••••••••') {
              await this.secrets.setSapPassword(message.value);
            }
            return;
          case 'saveAiCoreSecret':
            if (message.value && message.value !== '••••••••') {
              await this.secrets.setAiCoreClientSecret(message.value);
            }
            return;
          case 'testSapConnection': {
            const ok = await SettingsService.testSapConnection(this.secrets);
            this._post({ type: 'sapConnectionResult', ok });
            return;
          }
          case 'testAiCoreConnection': {
            const ok = await SettingsService.testAiCoreConnection(this.secrets);
            this._post({ type: 'aiCoreConnectionResult', ok });
            return;
          }
          case 'getSettings': {
            const cfg = vscode.workspace.getConfiguration('corepilot');
            const sapPass = await this.secrets.getSapPassword();
            const aiSec = await this.secrets.getAiCoreClientSecret();
            this._post({
              type: 'settingsConfig',
              // Boolean flags — never send the raw secret to the webview
              sapPasswordSet: !!sapPass,
              aiSecretSet: !!aiSec,
              settings: {
                sapHost: cfg.get('sap.host') || '',
                sapClient: cfg.get('sap.client') || '100',
                sapUsername: cfg.get('sap.username') || '',
                sapTargetRelease: cfg.get('sap.targetRelease') || '2023',
                sapAtcVariant: cfg.get('sap.atcVariant') || '',
                sapPassword: '',          // always empty; keychain is the source of truth
                aiTokenUrl: cfg.get('aicore.tokenUrl') || '',
                aiClientId: cfg.get('aicore.clientId') || '',
                aiApiBase: cfg.get('aicore.apiBase') || '',
                aiDeploymentId: cfg.get('aicore.deploymentId') || '',
                aiResourceGroup: cfg.get('aicore.resourceGroup') || 'default',
                aiClientSecret: '',       // always empty; keychain is the source of truth
              },
            });
            return;
          }
          case 'updateConfig':
            if (message.key && message.value !== undefined) {
              await vscode.workspace
                .getConfiguration('corepilot')
                .update(message.key, message.value, vscode.ConfigurationTarget.Global);
            }
            return;

          // ── Scan ────────────────────────────────────────────────────────
          case 'startScan':
            await ScannerAgent.run(
              this.secrets,
              (current, total, objectName) => {
                this._post({ type: 'scanProgress', current, total, objectName });
              },
              (objects) => {
                this.sidebar.refresh(objects);
                const dependencyGraph = ScannerAgent.loadDependencyGraphFromDisk();
                this._post({ type: 'scanComplete', objects, dependencyGraph, scanStatus: 'complete', scanPhase: 'complete' });
              },
              (errorMessage) => {
                this._post({ type: 'scanError', message: errorMessage });
                vscode.window.showErrorMessage(`A-CorePilot scan failed: ${errorMessage}`);
              }
            );
            return;

          case 'loadScanResults': {
            const saved = ScannerAgent.loadFromDisk();
            const dependencyGraph = ScannerAgent.loadDependencyGraphFromDisk();
            if (saved) {
              this.sidebar.refresh(saved.objects);
              this._post({
                type: 'scanComplete',
                objects: saved.objects,
                dependencyGraph,
                fromCache: true,
                scannedAt: saved.scannedAt,
                scanStatus: saved.status,
                scanPhase: saved.phase,
              });
            } else {
              this._post({ type: 'noScanResults' });
            }
            return;
          }

          case 'loadDependencyGraph': {
            const dependencyGraph = ScannerAgent.loadDependencyGraphFromDisk();
            const saved = ScannerAgent.loadFromDisk();
            if (dependencyGraph) {
              this._post({
                type: 'dependencyGraphLoaded',
                dependencyGraph,
                scanStatus: saved?.status,
                scanPhase: saved?.phase,
              });
            } else {
              this._post({ type: 'noDependencyGraph' });
            }
            return;
          }
        }
      },
      null,
      this._disposables
    );
  }

  // ── Public posting helpers (called from extension.ts commands) ─────────

  public postScanProgress(current: number, total: number, objectName: string): void {
    this._post({ type: 'scanProgress', current, total, objectName });
  }

  public postScanComplete(objects: EnrichedObject[], fromCache = false, scannedAt?: string): void {
    const dependencyGraph = ScannerAgent.loadDependencyGraphFromDisk();
    this._post({ type: 'scanComplete', objects, dependencyGraph, fromCache, scannedAt });
  }

  public postScanError(message: string): void {
    this._post({ type: 'scanError', message });
  }

  private _post(message: object): void {
    this._panel.webview.postMessage(message);
  }

  public dispose() {
    DashboardPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      this._disposables.pop()?.dispose();
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'index.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'index.css'));
    const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'logo.png'));
    const nonce = this.getNonce();

    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>A-CorePilot Dashboard</title>
        <link rel="stylesheet" href="${styleUri}">
      </head>
      <body>
        <div id="root"></div>
        <script nonce="${nonce}">window.LOGO_URI = "${logoUri}";</script>
        <script nonce="${nonce}" src="${scriptUri}"></script>
      </body>
      </html>`;
  }

  private getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
    return text;
  }
}
