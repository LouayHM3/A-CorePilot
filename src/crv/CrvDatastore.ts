import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// ── Constants ─────────────────────────────────────────────────────────────────

const CRV_BASE_URL =
  'https://raw.githubusercontent.com/SAP/abap-atc-cr-cv-s4hc/main/src/';

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Maps the user's `corepilot.sap.targetRelease` setting to the corresponding
 * CRV JSON file in the SAP GitHub repository.
 *
 * The actual SAP repo structure (as of 2025) has files directly under `src/`
 * named `objectReleaseInfo_PCE{year}_{fps}.json` — there are NO subdirectories
 * per release.  The mapping below uses the most recent FPS for each year.
 */
const RELEASE_FILE_MAP: Record<string, string> = {
  '2022':   'objectReleaseInfo_PCE2022_2.json',
  '2023':   'objectReleaseInfo_PCE2023_3.json',
  '2024':   'objectReleaseInfo_PCE2023_3.json', // No 2024 file — fallback to 2023
  '2025':   'objectReleaseInfo_PCE2025_1.json',
  'latest': 'objectReleaseInfoLatest.json',
  'BTP':    'objectReleaseInfo_BTPLatest.json',
};

const DEFAULT_CRV_FILE = 'objectReleaseInfoLatest.json';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CrvSuccessor {
  objectType: string;
  objectKey: string;
}

export interface CrvEntry {
  objectType: string;
  objectKey: string;
  state: 'deprecated' | 'released' | string;
  softwareComponent?: string;
  applicationComponent?: string;
  /** How many successors: 'oneObject' | 'multipleObjects' | 'concept' */
  successorClassification?: 'oneObject' | 'multipleObjects' | 'concept';
  /** List of direct successor objects (present when successorClassification is 'oneObject' or 'multipleObjects') */
  successors?: CrvSuccessor[];
  /** Human-readable concept name (present when successorClassification is 'concept') */
  successorConceptName?: string;
}

// ── Helper: build index key ───────────────────────────────────────────────────

function indexKey(objectType: string, objectName: string): string {
  return `${objectType.toUpperCase()}::${objectName.toUpperCase()}`;
}

// ── Helper: resolve CRV filename from target release ─────────────────────────

function resolveFilename(targetRelease: string | undefined): string {
  if (!targetRelease) return DEFAULT_CRV_FILE;
  return RELEASE_FILE_MAP[targetRelease] ?? DEFAULT_CRV_FILE;
}

// ── Helper: stale check ───────────────────────────────────────────────────────

function readTimestampMs(timestampFile: string): number {
  try {
    const raw = fs.readFileSync(timestampFile, 'utf-8').trim();
    const ts = parseInt(raw, 10);
    return isNaN(ts) ? 0 : ts;
  } catch {
    return 0; // file absent = never updated
  }
}

function writeTimestampMs(timestampFile: string): void {
  fs.writeFileSync(timestampFile, String(Date.now()), 'utf-8');
}

function isStale(timestampFile: string): boolean {
  return (Date.now() - readTimestampMs(timestampFile)) > STALE_THRESHOLD_MS;
}

// ── Helper: HTTPS file download ───────────────────────────────────────────────

function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath + '.tmp');

    https.get(url, { rejectUnauthorized: false }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // Follow redirect
        const location = res.headers.location;
        if (location) {
          file.close();
          fs.unlinkSync(destPath + '.tmp');
          downloadFile(location, destPath).then(resolve).catch(reject);
          return;
        }
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(destPath + '.tmp'); } catch { /* ignore */ }
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          // Atomically replace the old file
          try { fs.renameSync(destPath + '.tmp', destPath); } catch { /* ignore */ }
          resolve();
        });
      });
      res.on('error', (err) => {
        file.close();
        try { fs.unlinkSync(destPath + '.tmp'); } catch { /* ignore */ }
        reject(err);
      });
    }).on('error', (err) => {
      file.close();
      try { fs.unlinkSync(destPath + '.tmp'); } catch { /* ignore */ }
      reject(err);
    });
  });
}

// ── CrvDatastore ──────────────────────────────────────────────────────────────

/**
 * Singleton that manages the local CRV (Custom Release Validation) catalogue.
 *
 * On first access, it:
 *   1. Checks if the local copy is stale (> 24 hours old)
 *   2. If stale, silently downloads the correct JSON file from GitHub in the
 *      background (does NOT block extension startup)
 *   3. Builds an in-memory index for O(1) lookup by (objectType, objectName)
 *
 * Usage:
 *   await CrvDatastore.initialize(context);   // call once in activate()
 *   const crv = CrvDatastore.getInstance();
 *   const entry = crv?.lookup('CLAS', 'CL_AUNIT_ASSERT');
 */
export class CrvDatastore {
  private static instance: CrvDatastore | null = null;
  private static initializing = false;

  private readonly crvDir: string;
  private readonly outputChannel: vscode.OutputChannel;
  private index: Map<string, CrvEntry> = new Map();
  private ready = false;

  private constructor(
    crvDir: string,
    outputChannel: vscode.OutputChannel,
  ) {
    this.crvDir = crvDir;
    this.outputChannel = outputChannel;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Initialize the CRV datastore singleton.
   * Safe to call multiple times — subsequent calls are no-ops.
   *
   * @param context  VS Code extension context (used to resolve storage paths)
   */
  static async initialize(context: vscode.ExtensionContext): Promise<CrvDatastore> {
    if (CrvDatastore.instance) return CrvDatastore.instance;
    if (CrvDatastore.initializing) {
      // Wait for the ongoing initialization to finish
      await new Promise<void>(resolve => {
        const poll = setInterval(() => {
          if (!CrvDatastore.initializing) { clearInterval(poll); resolve(); }
        }, 200);
      });
      return CrvDatastore.instance!;
    }

    CrvDatastore.initializing = true;

    // Resolve workspace-scoped CRV directory
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath;
    const crvDir = workspaceRoot
      ? path.join(workspaceRoot, '.corepilot', 'crv')
      : path.join(context.globalStorageUri.fsPath, 'crv');

    const outputChannel = vscode.window.createOutputChannel('A-CorePilot CRV');
    const store = new CrvDatastore(crvDir, outputChannel);

    try {
      await store.ensureUpToDate();
    } finally {
      CrvDatastore.initializing = false;
    }

    CrvDatastore.instance = store;
    return store;
  }

  /** Return the singleton, or null if not yet initialized. */
  static getInstance(): CrvDatastore | null {
    return CrvDatastore.instance;
  }

  /**
   * Look up a SAP object in the CRV catalogue.
   *
   * @param objectType  ABAP object type (e.g. 'CLAS', 'PROG', 'FUGR')
   * @param objectName  Object name (case-insensitive)
   * @returns CrvEntry if the object is in the CRV catalogue, otherwise undefined
   */
  lookup(objectType: string, objectName: string): CrvEntry | undefined {
    if (!this.ready) return undefined;
    return this.index.get(indexKey(objectType, objectName));
  }

  /** True if the index has been built and lookups are available. */
  get isReady(): boolean {
    return this.ready;
  }

  /** Number of entries in the current index. */
  get size(): number {
    return this.index.size;
  }

  // ── Private implementation ─────────────────────────────────────────────────

  private log(msg: string): void {
    this.outputChannel.appendLine(`[CRV] ${msg}`);
    console.log(`[CRV] ${msg}`);
  }

  private getTargetRelease(): string {
    const config = vscode.workspace.getConfiguration('corepilot');
    return config.get<string>('sap.targetRelease') || '2023';
  }

  private resolveLocalPaths(): { jsonFile: string; timestampFile: string; crvFilename: string } {
    const targetRelease = this.getTargetRelease();
    const crvFilename = resolveFilename(targetRelease);
    const jsonFile = path.join(this.crvDir, crvFilename);
    const timestampFile = path.join(this.crvDir, '.last-updated');
    return { jsonFile, timestampFile, crvFilename };
  }

  /**
   * Main entry point:
   *   - If stale: download in background, then build index from disk
   *   - If fresh: build index from disk immediately
   *   - If no local copy at all: download synchronously before building index
   */
  private async ensureUpToDate(): Promise<void> {
    if (!fs.existsSync(this.crvDir)) {
      fs.mkdirSync(this.crvDir, { recursive: true });
    }

    const { jsonFile, timestampFile, crvFilename } = this.resolveLocalPaths();
    const fileExists = fs.existsSync(jsonFile);
    const stale = isStale(timestampFile);

    if (!fileExists) {
      // First run — must download synchronously before building index
      this.log(`No local CRV cache found. Downloading ${crvFilename} ...`);
      try {
        await downloadFile(CRV_BASE_URL + crvFilename, jsonFile);
        writeTimestampMs(timestampFile);
        this.log(`Download complete.`);
      } catch (err: any) {
        this.log(`Download failed: ${err.message}. CRV lookups will be unavailable.`);
        return;
      }
    } else if (stale) {
      // Cache is stale — trigger silent background refresh, but don't wait for it
      this.log(`Cache is stale (> 24h). Triggering silent background refresh of ${crvFilename} ...`);
      this.downloadInBackground(crvFilename, jsonFile, timestampFile);
    } else {
      this.log(`Cache is fresh. Building index from disk (${crvFilename}).`);
    }

    // Always build from whatever is local (fresh or just-downloaded)
    await this.buildIndex(jsonFile);
  }

  /**
   * Fire-and-forget background download + index rebuild.
   * Does NOT block extension startup.
   */
  private downloadInBackground(
    crvFilename: string,
    jsonFile: string,
    timestampFile: string,
  ): void {
    downloadFile(CRV_BASE_URL + crvFilename, jsonFile)
      .then(() => {
        writeTimestampMs(timestampFile);
        this.log(`Background refresh complete. Rebuilding index ...`);
        return this.buildIndex(jsonFile);
      })
      .catch((err: any) => {
        this.log(`Background refresh failed: ${err.message}`);
      });
  }

  /**
   * Parse the local CRV JSON file and populate the in-memory index.
   */
  private async buildIndex(jsonFile: string): Promise<void> {
    if (!fs.existsSync(jsonFile)) {
      this.log(`JSON file not found at ${jsonFile} — skipping index build.`);
      return;
    }

    try {
      this.log(`Building index from ${path.basename(jsonFile)} ...`);
      const raw = fs.readFileSync(jsonFile, 'utf-8');
      const parsed = JSON.parse(raw);
      const entries: any[] = parsed.objectReleaseInfo ?? [];

      const newIndex = new Map<string, CrvEntry>();
      for (const entry of entries) {
        if (!entry.objectType || !entry.objectKey) continue;
        const key = indexKey(entry.objectType, entry.objectKey);
        newIndex.set(key, entry as CrvEntry);
      }

      this.index = newIndex;
      this.ready = true;
      this.log(`Index built: ${this.index.size} entries loaded.`);
    } catch (err: any) {
      this.log(`Failed to build index: ${err.message}`);
    }
  }
}
