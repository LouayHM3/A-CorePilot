import { EnrichedObject } from '../sap/ObjectDiscovery';
import { computeAtcDebtScore, computeCompositeDebtScore, computeEffortSP } from '../debt/DebtFormula';
import { AiCoreClient } from '../services/AiCoreClient';
import { SecretStorageService } from '../services/SecretStorageService';

export class DebtAnalystAgent {
  static async run(
    objects: EnrichedObject[],
    secrets?: SecretStorageService,
    onProgress?: (current: number, total: number, objectName: string) => void,
    log?: (msg: string) => void
  ): Promise<void> {
    const _log = log ?? ((msg: string) => console.log(msg));
    const total = objects.length;
    const aiClient = secrets ? new AiCoreClient(secrets) : null;

    _log(`[DebtAnalystAgent] Calculating technical debt & effort for ${total} objects...`);

    for (let i = 0; i < total; i++) {
      const obj = objects[i];
      if (onProgress) {
        onProgress(i + 1, total, `Debt Analysis [${i + 1}/${total}] ${obj.name}`);
      }

      // Step 1: Determine modification type (using LLM or fallback)
      if (!obj.modType && aiClient) {
        try {
          obj.modType = await aiClient.classifyModificationType(obj.name, '');
        } catch {
          obj.modType = 'CUSTOM_DEVELOPMENT';
        }
      }
      if (!obj.modType) {
        obj.modType = 'CUSTOM_DEVELOPMENT';
      }

      const graphDepth = obj.graphDepth ?? Math.min(10, Math.floor((obj.callerCount || 0) / 2));

      // Step 2: Compute ATC-specific debt points (10 per error, 5 per warning, 1 per info)
      obj.atcFindingsCount = obj.atcFindings ? obj.atcFindings.length : 0;
      const atcPoints = computeAtcDebtScore(obj.atcFindings || []);

      // Step 3: Compute Composite Debt Score (0–100)
      obj.debtScore = computeCompositeDebtScore({
        atcFindings: obj.atcFindings || [],
        loc: obj.loc || 0,
        graphDepth,
        modType: obj.modType,
        lastChangedDate: obj.lastChangedDate || '',
      });

      // Step 4: Compute Story Points Effort
      obj.effortSP = computeEffortSP(obj.classification, graphDepth);
    }

    _log(`[DebtAnalystAgent] Technical debt & effort calculation complete.`);
  }
}
