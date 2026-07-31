/**
 * Shared VS Code API instance.
 * acquireVsCodeApi() may only be called ONCE per webview lifetime.
 * Import `vscode` from this module everywhere instead of calling it directly.
 */

// @ts-ignore — acquireVsCodeApi is injected by VS Code at runtime
export const vscode = acquireVsCodeApi();
