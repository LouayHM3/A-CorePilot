import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AdtClient, AdtConfig } from '../sap/AdtClient';
import { ObjectDiscovery, EnrichedObject } from '../sap/ObjectDiscovery';
import { SecretStorageService } from '../services/SecretStorageService';
import { SettingsService } from '../services/SettingsService';
import { AtcAgent } from './AtcAgent';
import { CrvDatastore } from '../crv/CrvDatastore';
import { DebtAnalystAgent } from './DebtAnalystAgent';
import { SerializedDependencyGraph } from '../graph/DependencyGraph';
import { buildDependencyGraph, loadDependencyGraph, persistDependencyGraph } from '../graph/GraphSerializer';
import { AiCoreClient } from '../services/AiCoreClient';

export interface ScanResult {
  version: 2;
  scannedAt: string;
  sapHost: string;
  status: 'partial' | 'complete';
  phase: 'discovery' | 'atc' | 'complete';
  objects: EnrichedObject[];
}

export class ScannerAgent {
  private static readonly OUTPUT_CHANNEL = vscode.window.createOutputChannel('A-CorePilot');
  private static storageRoot: string | undefined;
  private static scanRunning = false;

  static initializeStorage(storageRoot: string): void {
    ScannerAgent.storageRoot = storageRoot;
  }

  /**
   * Run the full discovery scan.
   * @param onProgress  Called per object with (current, total, objectName)
   * @param onComplete  Called with the final result array
   * @param onError     Called with a user-facing error message
   */
  static async run(
    secrets: SecretStorageService,
    onProgress: (current: number, total: number, objectName: string) => void,
    onComplete: (objects: EnrichedObject[]) => void,
    onError: (message: string) => void
  ): Promise<void> {
    if (ScannerAgent.scanRunning) {
      onError('A scan is already running. Wait for it to finish before starting another scan.');
      return;
    }

    ScannerAgent.scanRunning = true;
    try {
      await ScannerAgent.runInternal(secrets, onProgress, onComplete, onError);
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      ScannerAgent.OUTPUT_CHANNEL.appendLine(`[ScannerAgent] Unexpected scan failure: ${message}`);
      onError(`Unexpected scan failure: ${message}`);
    } finally {
      ScannerAgent.scanRunning = false;
    }
  }

  private static async runInternal(
    secrets: SecretStorageService,
    onProgress: (current: number, total: number, objectName: string) => void,
    onComplete: (objects: EnrichedObject[]) => void,
    onError: (message: string) => void
  ): Promise<void> {
    const log = (msg: string) => ScannerAgent.OUTPUT_CHANNEL.appendLine(`[ScannerAgent] ${msg}`);

    // 1. Build credentials
    const config = vscode.workspace.getConfiguration('corepilot');
    const host = config.get<string>('sap.host') ?? '';
    const client = config.get<string>('sap.client') ?? '100';
    const username = config.get<string>('sap.username') ?? '';
    const password = await secrets.getSapPassword() ?? '';

    if (!host || !username || !password) {
      onError('SAP credentials are missing. Please configure them in Settings.');
      return;
    }

    const adtConfig: AdtConfig = { host, client, username, password };
    const adtClient = new AdtClient(adtConfig);
    const aiClient = new AiCoreClient(secrets);

    // 2. Ping
    log(`Connecting to ${host} …`);
    let reachable = false;
    try {
      reachable = await adtClient.ping();
    } catch (e: any) {
      onError(`Cannot reach SAP system: ${e.message}`);
      return;
    }

    if (!reachable) {
      onError('SAP ADT endpoint returned a non-200 response. Check host, client, and credentials.');
      return;
    }

    log('ADT connection OK. Starting object discovery …');

    // Starting a new verified scan invalidates the previous completed cache.
    // If discovery is interrupted, the UI will show an explicit checkpoint.
    ScannerAgent.persist(host, [], 'partial', 'discovery');

    // 3. Discover objects
    const discovery = new ObjectDiscovery(
      adtClient,
      (sourceCode, obj) => aiClient.extractDependenciesFromAbap(obj.name, obj.type, sourceCode)
    );
    let objects: EnrichedObject[] = [];

    try {
      objects = await discovery.discoverAll((current, total, name) => {
        log(`[${current}/${total}] ${name}`);
        onProgress(current, total, name);
      }, log);
    } catch (e: any) {
      onError(`Discovery failed: ${e.message}`);
      return;
    }

    log(`Discovery complete — ${objects.length} objects found. Starting ATC scans...`);
    // Replace stale results immediately. A later interruption leaves an
    // explicitly partial checkpoint instead of an apparently current scan.
    ScannerAgent.persist(host, objects, 'partial', 'discovery');

    let dependencyGraph: SerializedDependencyGraph | undefined;
    try {
      dependencyGraph = buildDependencyGraph(objects);
      ScannerAgent.persistGraph(dependencyGraph);
      log(`Dependency graph prepared: ${dependencyGraph.stats.nodeCount} nodes, ${dependencyGraph.stats.edgeCount} edges.`);
    } catch (e: any) {
      log(`Dependency graph preparation failed: ${e.message}`);
    }

    // Only send a checkVariant if the user explicitly configured one.
    // Sending a non-existent variant name causes SAP to throw ExceptionParameterNotFound.
    const atcVariant = SettingsService.getConfiguredAtcVariant();
    const targetRelease = SettingsService.getConfiguredTargetRelease();
    log(`ATC check variant: ${atcVariant ?? '(system default)'}, target release: ${targetRelease}`);

    try {
      await AtcAgent.run(
        objects,
        adtClient,
        atcVariant,
        targetRelease,
        (current, total, name) => {
          onProgress(current, total, `ATC Scanning [${current}/${total}] ${name}`);
        },
        log
      );
    } catch (e: any) {
      onError(`ATC scan failed: ${e.message}`);
      return;
    }

    log('ATC scans complete.');
    ScannerAgent.persist(host, objects, 'partial', 'atc');

    try {
      dependencyGraph = buildDependencyGraph(objects);
      log(`Dependency graph validated with ATC: ${dependencyGraph.stats.nodeCount} nodes, ${dependencyGraph.stats.edgeCount} edges.`);
    } catch (e: any) {
      log(`Dependency graph ATC validation failed: ${e.message}`);
    }

    // Phase 4: CRV enrichment — annotate each object with its CRV entry (successor info)
    const crv = CrvDatastore.getInstance();
    if (crv && crv.isReady) {
      let enrichedCount = 0;
      for (const obj of objects) {
        // CRV uses TADIR object types (e.g. CLAS, PROG, FUGR, INTF) — strip subtype
        const baseType = obj.type.split('/')[0];
        const entry = crv.lookup(baseType, obj.name);
        if (entry) {
          obj.crvEntry = entry;
          enrichedCount++;
        }
      }
      log(`CRV enrichment complete: ${enrichedCount}/${objects.length} objects have a CRV entry.`);
    } else {
      log('CRV datastore not yet ready — skipping CRV enrichment.');
    }

    // Phase 5: Technical Debt & Effort Estimation
    try {
      await DebtAnalystAgent.run(
        objects,
        secrets,
        (current: number, total: number, name: string) => {
          onProgress(current, total, name);
        },
        log
      );
    } catch (e: any) {
      log(`Debt analysis failed: ${e.message}`);
    }

    try {
      dependencyGraph = buildDependencyGraph(objects);
      ScannerAgent.persistGraph(dependencyGraph);
      log(`Dependency graph persisted: ${dependencyGraph.stats.nodeCount} nodes, ${dependencyGraph.stats.edgeCount} edges, ${dependencyGraph.stats.cycleCount} cycles.`);
    } catch (e: any) {
      log(`Dependency graph persistence failed: ${e.message}`);
    }

    // 4. Persist to .corepilot/scan-results.json
    ScannerAgent.persist(host, objects, 'complete', 'complete');

    // 5. Notify caller
    onComplete(objects);
  }

  /** Load previously persisted scan results, or return null. */
  static loadFromDisk(): ScanResult | null {
    const filePath = ScannerAgent.getResultsPath();
    if (!filePath || !fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as ScanResult;
      if (parsed.version !== 2 || !Array.isArray(parsed.objects)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  static loadDependencyGraphFromDisk(): SerializedDependencyGraph | null {
    const filePath = ScannerAgent.getGraphPath();
    if (!filePath) return null;

    const savedGraph = loadDependencyGraph(filePath);
    if (savedGraph) return savedGraph;

    const savedScan = ScannerAgent.loadFromDisk();
    if (!savedScan) return null;

    try {
      const rebuilt = buildDependencyGraph(savedScan.objects);
      ScannerAgent.persistGraph(rebuilt);
      return rebuilt;
    } catch {
      return null;
    }
  }

  private static persist(
    sapHost: string,
    objects: EnrichedObject[],
    status: ScanResult['status'],
    phase: ScanResult['phase']
  ): void {
    const filePath = ScannerAgent.getResultsPath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const result: ScanResult = {
      version: 2,
      scannedAt: new Date().toISOString(),
      sapHost,
      status,
      phase,
      objects,
    };
    const temporaryPath = `${filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(result, null, 2), 'utf-8');
    fs.renameSync(temporaryPath, filePath);
  }

  private static persistGraph(graph: SerializedDependencyGraph): void {
    const filePath = ScannerAgent.getGraphPath();
    persistDependencyGraph(filePath, graph);
  }

  private static getResultsPath(): string {
    return path.join(ScannerAgent.getStorageRoot(), 'scan-results.json');
  }

  private static getGraphPath(): string {
    return path.join(ScannerAgent.getStorageRoot(), 'dependency-graph.json');
  }

  private static getStorageRoot(): string {
    if (!ScannerAgent.storageRoot) {
      throw new Error('Scanner storage has not been initialized.');
    }
    if (!fs.existsSync(ScannerAgent.storageRoot)) {
      fs.mkdirSync(ScannerAgent.storageRoot, { recursive: true });
    }
    return ScannerAgent.storageRoot;
  }
}
