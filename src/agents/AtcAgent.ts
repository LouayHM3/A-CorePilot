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
    // Technical program parts are checked as part of their standalone parent.
    const excludedSubtypes = new Set(['I', 'S', 'M', 'F', 'K', 'J']);
    const targets = objects.filter(obj => !excludedSubtypes.has(obj.type.split('/')[1] ?? ''));
    const total = targets.length;
    const concurrency = 2;

    log(`ATC targets: ${total}/${objects.length} standalone objects (${objects.length - total} technical child objects covered by parents).`);

    const scanObject = async (obj: EnrichedObject, i: number): Promise<void> => {
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
    };

    for (let start = 0; start < total; start += concurrency) {
      const batch = targets.slice(start, start + concurrency);
      await Promise.all(batch.map((obj, offset) => scanObject(obj, start + offset)));
    }
  }
}
