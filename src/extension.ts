import * as vscode from 'vscode';
import { SecretStorageService } from './services/SecretStorageService';
import { SettingsService } from './services/SettingsService';
import { SidebarProvider } from './ui/sidebar/SidebarProvider';
import { DashboardPanel } from './ui/webview/DashboardPanel';
import { ScannerAgent } from './agents/ScannerAgent';
import { CrvDatastore } from './crv/CrvDatastore';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const secretStorage = new SecretStorageService(context.secrets);
  const sidebar = new SidebarProvider(context);

  vscode.window.registerTreeDataProvider('corepilotSidebar', sidebar);

  // Load persisted scan results into sidebar on startup (non-blocking)
  const saved = ScannerAgent.loadFromDisk();
  if (saved) {
    sidebar.refresh(saved.objects);
  }

  // Phase 4: Initialize CRV datastore — downloads/refreshes in background if stale.
  // Non-blocking: does NOT delay extension startup.
  CrvDatastore.initialize(context).catch((err: any) =>
    console.error(`[CRV] Initialization error: ${err.message}`)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('corepilot.openDashboard', () => {
      DashboardPanel.createOrShow(context.extensionUri, secretStorage, sidebar);
    }),

    vscode.commands.registerCommand('corepilot.startScan', async () => {
      // Ensure dashboard is open so the user sees progress
      DashboardPanel.createOrShow(context.extensionUri, secretStorage, sidebar);
      // Small delay so the webview has time to mount before we fire messages
      await new Promise(r => setTimeout(r, 500));
      await ScannerAgent.run(
        secretStorage,
        (current, total, objectName) => {
          DashboardPanel.currentPanel?.postScanProgress(current, total, objectName);
        },
        (objects) => {
          sidebar.refresh(objects);
          DashboardPanel.currentPanel?.postScanComplete(objects);
        },
        (message) => {
          DashboardPanel.currentPanel?.postScanError(message);
          vscode.window.showErrorMessage(`A-CorePilot: ${message}`);
        }
      );
    }),

    vscode.commands.registerCommand('corepilot.testSapConnection', async () => {
      await SettingsService.testSapConnection(secretStorage);
    }),

    vscode.commands.registerCommand('corepilot.testAiCoreConnection', async () => {
      await SettingsService.testAiCoreConnection(secretStorage);
    })
  );
}

export function deactivate() {
  if (DashboardPanel.currentPanel) {
    DashboardPanel.currentPanel.dispose();
  }
}
