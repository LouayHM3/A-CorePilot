import * as vscode from 'vscode';

export class SecretStorageService {
  constructor(private readonly store: vscode.SecretStorage) {}

  async getSapPassword(): Promise<string | undefined> {
    return this.store.get('corepilot.sap.password');
  }
  
  async setSapPassword(value: string): Promise<void> {
    await this.store.store('corepilot.sap.password', value);
  }
  
  async getAiCoreClientSecret(): Promise<string | undefined> {
    return this.store.get('corepilot.aicore.clientSecret');
  }
  
  async setAiCoreClientSecret(value: string): Promise<void> {
    await this.store.store('corepilot.aicore.clientSecret', value);
  }
}
