import * as vscode from 'vscode';
import { SecretStorageService } from './SecretStorageService';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

export class SettingsService {
  static getConfiguredAtcVariant(): string | undefined {
    const config = vscode.workspace.getConfiguration('corepilot');
    const inspected = config.inspect<string>('sap.atcVariant');

    // Standard VS Code priority: Folder > Workspace > Global > Default
    let variant: string | undefined;
    if (inspected?.workspaceFolderValue !== undefined) {
      variant = inspected.workspaceFolderValue;
    } else if (inspected?.workspaceValue !== undefined) {
      variant = inspected.workspaceValue;
    } else if (inspected?.globalValue !== undefined) {
      variant = inspected.globalValue;
    } else {
      variant = inspected?.defaultValue;
    }

    if (variant === undefined) {
      variant = config.get<string>('sap.atcVariant');
    }

    const trimmed = variant?.toString().trim();
    // Always fallback to 'ZABAP_CLOUD_DEV_DEFAULT' if empty or undefined
    return trimmed || 'ZABAP_CLOUD_DEV_DEFAULT';
  }

  static getConfiguredTargetRelease(): string {
    const config = vscode.workspace.getConfiguration('corepilot');
    return config.get<string>('sap.targetRelease') || '2023';
  }

  static async testSapConnection(secretStorage: SecretStorageService): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('corepilot');
    const host = config.get<string>('sap.host');
    const client = config.get<string>('sap.client');
    const username = config.get<string>('sap.username');
    const password = await secretStorage.getSapPassword();

    if (!host || !username || !password) {
      vscode.window.showErrorMessage('Missing SAP credentials or host in settings.');
      return false;
    }

    try {
      const url = new URL(host);
      url.pathname = '/sap/bc/adt/discovery';
      url.searchParams.set('sap-client', client || '100');

      const options = {
        method: 'GET',
        // SAP dev/test systems commonly use self-signed certificates
        rejectUnauthorized: false,
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
          'sap-client': client || '100',
          'Accept': 'application/atomsvc+xml'
        }
      };

      return new Promise<boolean>((resolve) => {
        const clientReq = url.protocol === 'https:' ? https.request : http.request;
        const req = clientReq(url, options, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode === 200) {
              vscode.window.showInformationMessage('SAP ADT connected successfully (HTTP 200)');
              resolve(true);
            } else {
              vscode.window.showErrorMessage(`SAP connection failed: HTTP ${res.statusCode} - ${data.substring(0, 2000)}`);
              resolve(false);
            }
          });
        });

        req.on('error', (err: any) => {
          let errorMsg = err.message;
          if (errorMsg.includes('WRONG_VERSION_NUMBER')) {
            errorMsg = `Protocol mismatch. You're using 'https://' but the server is responding with HTTP. Please change the SAP Host URL in settings to 'http://' or use the correct HTTPS port.`;
          }
          vscode.window.showErrorMessage(`SAP connection error: ${errorMsg}`);
          resolve(false);
        });

        req.end();
      });
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to parse SAP host URL: ${e.message}`);
      return false;
    }
  }

  static async testAiCoreConnection(secretStorage: SecretStorageService): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('corepilot');
    const tokenUrl = config.get<string>('aicore.tokenUrl');
    const clientId = config.get<string>('aicore.clientId');
    const apiBase = config.get<string>('aicore.apiBase');
    const deploymentId = config.get<string>('aicore.deploymentId');
    const secret = await secretStorage.getAiCoreClientSecret();

    if (!tokenUrl || !clientId || !apiBase || !deploymentId || !secret) {
      vscode.window.showErrorMessage('Missing SAP AI Core configuration or secret.');
      return false;
    }

    try {
      // 1. Get token
      const tokenParsedUrl = new URL(tokenUrl);
      const tokenOptions = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      };

      const token = await new Promise<string | null>((resolve) => {
        const req = https.request(tokenParsedUrl, tokenOptions, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode === 200) {
              const json = JSON.parse(data);
              resolve(json.access_token);
            } else {
              vscode.window.showErrorMessage(`AI Core Token failed: HTTP ${res.statusCode}`);
              resolve(null);
            }
          });
        });
        req.on('error', (err) => {
          vscode.window.showErrorMessage(`Token request error: ${err.message}`);
          resolve(null);
        });
        req.write(`grant_type=client_credentials&client_id=${clientId}&client_secret=${secret}`);
        req.end();
      });

      if (!token) return false;

      // 2. Test AI Core API
      const apiParsedUrl = new URL(`${apiBase}/v2/deployments/${deploymentId}`);
      const apiOptions = {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      };

      return new Promise<boolean>((resolve) => {
        const req = https.request(apiParsedUrl, apiOptions, (res) => {
          if (res.statusCode === 200) {
            vscode.window.showInformationMessage('SAP AI Core connected — deployment active');
            resolve(true);
          } else {
            vscode.window.showErrorMessage(`AI Core API failed: HTTP ${res.statusCode}`);
            resolve(false);
          }
        });
        req.on('error', (err) => {
          vscode.window.showErrorMessage(`AI Core API error: ${err.message}`);
          resolve(false);
        });
        req.end();
      });
    } catch (e: any) {
      vscode.window.showErrorMessage(`AI Core test exception: ${e.message}`);
      return false;
    }
  }
}
