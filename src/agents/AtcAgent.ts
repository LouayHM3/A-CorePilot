import { AdtClient } from '../sap/AdtClient';
import { EnrichedObject, extractAtcDependencies } from '../sap/ObjectDiscovery';
import { AtcRunner } from '../sap/AtcRunner';

export class AtcAgent {
  static async run(
    objects: EnrichedObject[],
    adtClient: AdtClient,
    atcVariant: string | undefined,
    targetRelease: string | undefined,
    onProgress: (current: number, total: number, objectName: string) => void,
    log: (msg: string) => void
  ): Promise<void> {
    const runner = new AtcRunner(adtClient);
    const total = objects.length;

    for (let i = 0; i < total; i++) {
      const obj = objects[i];
      onProgress(i + 1, total, obj.name);

      try {
        const findings = await runner.runForObject(obj.name, obj.type, obj.uri, atcVariant, targetRelease);
        obj.atcFindings = findings || [];
        const atcDependencies = extractAtcDependencies(obj.atcFindings, obj.name);
        if (atcDependencies.length > 0) {
          obj.dependencies = (obj.dependencies ?? []).concat(atcDependencies);
          log(`ATC cross-reference validation found ${atcDependencies.length} graph references for ${obj.name}`);
        }

        if (findings.some(f => f.priority === 1)) {
          obj.classification = 'D';
        } else if (findings.some(f => f.priority === 2)) {
          obj.classification = 'C';
        } else if (findings.some(f => f.priority === 3)) {
          obj.classification = 'B';
        } else if (findings.length === 0) {
          // ATC ran successfully and returned no findings → object is clean
          obj.classification = 'A';
        } else {
          obj.classification = undefined;
        }

      } catch (e: any) {
        log(`ATC failed for ${obj.name}: ${e.message}`);
        obj.atcFindings = [];
        obj.classification = undefined; // ATC failure => unclassified (-)
      }
    }
  }
}
