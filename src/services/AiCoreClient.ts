import * as vscode from 'vscode';
import * as https from 'https';
import { URL } from 'url';
import { SecretStorageService } from './SecretStorageService';
import { DependencyConfidence, DependencyKind, ModificationType, ObjectDependency } from '../sap/ObjectDiscovery';

export class AiCoreClient {
  constructor(private secretStorage: SecretStorageService) {}

  /**
   * Determine object modification type using SAP AI Core LLM inference.
   * If unconfigured or offline, returns default fallback 'CUSTOM_DEVELOPMENT'.
   */
  async classifyModificationType(objectName: string, sourceCode: string): Promise<ModificationType> {
    if (!sourceCode || sourceCode.trim().length === 0) {
      return 'CUSTOM_DEVELOPMENT';
    }

    // Heuristic fast check before calling API
    const nameUpper = objectName.toUpperCase();
    if (nameUpper.includes('BADI') || nameUpper.includes('ENH')) {
      return 'BADI_IMPLEMENTATION';
    }
    if (nameUpper.includes('PROXY') || nameUpper.includes('WRAP')) {
      return 'WRAPPER_PROXY';
    }

    try {
      const config = vscode.workspace.getConfiguration('corepilot');
      const tokenUrl = config.get<string>('aicore.tokenUrl');
      const clientId = config.get<string>('aicore.clientId');
      const apiBase = config.get<string>('aicore.apiBase');
      const deploymentId = config.get<string>('aicore.deploymentId');
      const resourceGroup = config.get<string>('aicore.resourceGroup') || 'default';
      const secret = await this.secretStorage.getAiCoreClientSecret();

      if (!tokenUrl || !clientId || !apiBase || !deploymentId || !secret) {
        return 'CUSTOM_DEVELOPMENT';
      }

      // 1. Fetch OAuth token
      const token = await this.getOAuthToken(tokenUrl, clientId, secret);
      if (!token) return 'CUSTOM_DEVELOPMENT';

      // 2. Call LLM Completion endpoint
      const prompt = `You are an SAP ABAP Clean Core expert. Classify the following ABAP object (${objectName}) into EXACTLY ONE of these categories:
- CLASSICAL_MODIFICATION
- IMPLICIT_ENHANCEMENT
- EXPLICIT_ENHANCEMENT
- BADI_IMPLEMENTATION
- CUSTOM_DEVELOPMENT
- WRAPPER_PROXY

Return ONLY the category name and nothing else.

Source Code Sample:
${sourceCode.substring(0, 1500)}`;

      const responseText = await this.invokeInference(apiBase, deploymentId, resourceGroup, token, prompt);
      const cleanResp = (responseText || '').trim().toUpperCase();

      const validTypes: ModificationType[] = [
        'CLASSICAL_MODIFICATION',
        'IMPLICIT_ENHANCEMENT',
        'EXPLICIT_ENHANCEMENT',
        'BADI_IMPLEMENTATION',
        'CUSTOM_DEVELOPMENT',
        'WRAPPER_PROXY',
      ];

      for (const vt of validTypes) {
        if (cleanResp.includes(vt)) {
          return vt;
        }
      }

      return 'CUSTOM_DEVELOPMENT';
    } catch {
      return 'CUSTOM_DEVELOPMENT';
    }
  }

  async extractDependenciesFromAbap(
    objectName: string,
    objectType: string,
    sourceCode: string
  ): Promise<ObjectDependency[]> {
    if (!sourceCode || sourceCode.trim().length === 0) {
      return [];
    }

    try {
      const config = vscode.workspace.getConfiguration('corepilot');
      const tokenUrl = config.get<string>('aicore.tokenUrl');
      const clientId = config.get<string>('aicore.clientId');
      const apiBase = config.get<string>('aicore.apiBase');
      const deploymentId = config.get<string>('aicore.deploymentId');
      const resourceGroup = config.get<string>('aicore.resourceGroup') || 'default';
      const secret = await this.secretStorage.getAiCoreClientSecret();

      if (!tokenUrl || !clientId || !apiBase || !deploymentId || !secret) {
        return [];
      }

      const token = await this.getOAuthToken(tokenUrl, clientId, secret);
      if (!token) return [];

      const prompt = `You are an SAP ABAP dependency extraction engine.
Return ONLY valid JSON. No markdown. No comments.

Analyze this ABAP object:
Object name: ${objectName}
Object type: ${objectType}

Find dependencies, including:
- function modules called
- classes or interfaces used
- programs submitted or called dynamically
- includes
- database tables/views used by Open SQL
- BAdIs, enhancements, exits, or enhancement spots

Return a JSON array. Each item must use this schema:
{
  "name": "OBJECT_NAME",
  "type": "CLAS|INTF|FUNC|PROG|TABL|VIEW|BADI|ENHO|UNKNOWN",
  "kind": "CALLS|INCLUDES|USES_TABLE|ENHANCES",
  "confidence": "high|medium|low",
  "reason": "short evidence from the source"
}

Only include real object dependencies. Prefer Z*/Y* custom objects and non-released SAP APIs mentioned explicitly.

ABAP source:
${sourceCode.substring(0, 9000)}`;

      const responseText = await this.invokeInference(apiBase, deploymentId, resourceGroup, token, prompt, 1200, 0);
      return parseDependencyJson(responseText)
        .filter(dep => dep.name !== normalizeObjectName(objectName))
        .slice(0, 60);
    } catch {
      return [];
    }
  }

  private getOAuthToken(tokenUrl: string, clientId: string, secret: string): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        const url = new URL(tokenUrl);
        const req = https.request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode === 200) {
              const json = JSON.parse(data);
              resolve(json.access_token || null);
            } else {
              resolve(null);
            }
          });
        });
        req.on('error', () => resolve(null));
        req.write(`grant_type=client_credentials&client_id=${clientId}&client_secret=${secret}`);
        req.end();
      } catch {
        resolve(null);
      }
    });
  }

  private invokeInference(
    apiBase: string,
    deploymentId: string,
    resourceGroup: string,
    token: string,
    prompt: string,
    maxTokens = 50,
    temperature = 0.1
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        const url = new URL(`${apiBase}/v2/inference/deployments/${deploymentId}/chat/completions`);
        const body = JSON.stringify({
          messages: [
            { role: 'user', content: prompt }
          ],
          max_tokens: maxTokens,
          temperature
        });

        const req = https.request(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'AI-Resource-Group': resourceGroup,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const json = JSON.parse(data);
                const content = json.choices?.[0]?.message?.content || '';
                resolve(content);
              } catch (e) {
                reject(e);
              }
            } else {
              reject(new Error(`HTTP ${res.statusCode}`));
            }
          });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      } catch (e) {
        reject(e);
      }
    });
  }
}

function parseDependencyJson(responseText: string): ObjectDependency[] {
  const raw = extractJsonArray(responseText);
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const dependencies: ObjectDependency[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = normalizeObjectName(String(record.name ?? ''));
    if (!name || !isLikelyObjectName(name)) continue;

    const kind = normalizeKind(String(record.kind ?? 'CALLS'));
    dependencies.push({
      name,
      type: normalizeType(String(record.type ?? ''), name, kind),
      kind,
      source: 'LLM',
      confidence: normalizeConfidence(String(record.confidence ?? 'medium')),
      rawText: truncate(String(record.reason ?? ''), 240),
    });
  }

  return dedupeDependencies(dependencies);
}

function extractJsonArray(text: string): string | null {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed;

  const first = trimmed.indexOf('[');
  const last = trimmed.lastIndexOf(']');
  if (first >= 0 && last > first) {
    return trimmed.slice(first, last + 1);
  }

  return null;
}

function normalizeObjectName(name: string): string {
  return name
    .trim()
    .replace(/^['"`]|['"`]$/g, '')
    .replace(/[.,;:)]+$/g, '')
    .toUpperCase();
}

function isLikelyObjectName(name: string): boolean {
  return /^(?:[ZY][A-Z0-9_/$-]+|CL_[A-Z0-9_/$-]+|IF_[A-Z0-9_/$-]+|BAPI_[A-Z0-9_/$-]+|BADI_[A-Z0-9_/$-]+)$/.test(name);
}

function normalizeKind(kind: string): DependencyKind {
  const upper = kind.trim().toUpperCase();
  const valid: DependencyKind[] = ['CALLS', 'INCLUDES', 'USES_TABLE', 'ENHANCES'];
  return valid.includes(upper as DependencyKind) ? upper as DependencyKind : 'CALLS';
}

function normalizeConfidence(confidence: string): DependencyConfidence {
  const upper = confidence.trim().toLowerCase();
  if (upper === 'high' || upper === 'medium' || upper === 'low') {
    return upper;
  }
  return 'medium';
}

function normalizeType(type: string, name: string, kind: DependencyKind): string {
  const upper = type.trim().toUpperCase();
  if (upper) return upper;
  if (/^(?:ZCL_|YCL_|CL_)/.test(name)) return 'CLAS';
  if (/^(?:ZIF_|YIF_|IF_)/.test(name)) return 'INTF';
  if (/^BAPI_/.test(name)) return 'FUNC';
  if (/^BADI_/.test(name)) return 'BADI';
  if (kind === 'USES_TABLE') return 'TABL';
  if (kind === 'INCLUDES') return 'PROG';
  return 'UNKNOWN';
}

function dedupeDependencies(dependencies: ObjectDependency[]): ObjectDependency[] {
  const seen = new Set<string>();
  const deduped: ObjectDependency[] = [];
  for (const dep of dependencies) {
    const key = `${dep.kind}::${dep.type}::${dep.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(dep);
  }
  return deduped;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}
