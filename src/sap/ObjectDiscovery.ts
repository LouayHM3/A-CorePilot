import { AdtClient } from './AdtClient';
import { CrvEntry } from '../crv/CrvDatastore';

// ── Domain types (shared across all phases) ──────────────────────────────────

export type Classification = 'A' | 'B' | 'C' | 'D';
export type RiskLevel = 'Low' | 'Medium' | 'High' | 'Critical';
export type ModificationType =
  | 'CLASSICAL_MODIFICATION'
  | 'IMPLICIT_ENHANCEMENT'
  | 'EXPLICIT_ENHANCEMENT'
  | 'BADI_IMPLEMENTATION'
  | 'CUSTOM_DEVELOPMENT'
  | 'WRAPPER_PROXY';

export interface AtcFinding {
  checkId: string;
  priority: 1 | 2 | 3;
  message: string;
  location?: string;
}

export interface RiskDimensions {
  r1_coupling: number;
  r2_complexity: number;
  r3_exposure: number;
  r4_volatility: number;
  r5_modType: number;
  r6_dataSensitivity: number;
}

export type DependencyKind = 'CALLS' | 'INCLUDES' | 'USES_TABLE' | 'ENHANCES';
export type DependencySource = 'ADT_WHERE_USED' | 'SOURCE_PATTERN' | 'LLM' | 'ATC_FINDING';
export type DependencyConfidence = 'high' | 'medium' | 'low';

export interface DependencyReference {
  name: string;
  type: string;
  uri?: string;
  packageName?: string;
  description?: string;
}

export interface ObjectDependency extends DependencyReference {
  kind: DependencyKind;
  source: DependencySource;
  confidence: DependencyConfidence;
  rawText?: string;
}

export type LlmDependencyExtractor = (
  sourceCode: string,
  object: { name: string; type: string; packageName?: string; description?: string }
) => Promise<ObjectDependency[]>;

export interface EnrichedObject {
  // From ADT search
  name: string;
  type: string;
  uri: string;    // ADT URI e.g. /sap/bc/adt/programs/programs/ZFOO — used for ATC runs
  packageName: string;
  description: string;
  // From where-used
  callerCount: number;
  calleeCount: number;
  callers: DependencyReference[];
  dependencies: ObjectDependency[];
  graphDepth: number;
  // From transport log
  changesLast12Months: number;
  lastChangedDate: string;
  // From source code
  loc: number;
  // Set by AtcAgent (P3)
  classification: Classification | undefined;
  atcFindings: AtcFinding[];
  atcFindingsCount: number;
  modType: ModificationType | undefined;
  // Set by CrvDatastore (P4)
  crvEntry: CrvEntry | undefined;
  // Set by DebtAnalystAgent (P5)
  debtScore: number | undefined;
  effortSP: number | undefined;
  riskScore: number | undefined;
  riskLevel: RiskLevel | undefined;
  riskDimensions: RiskDimensions | undefined;
  riskAdvisory: string | undefined;
}

// ── Object types to scan ─────────────────────────────────────────────────────

const OBJECT_TYPES = ['PROG', 'CLAS', 'FUGR', 'INTF'];
const SOURCE_TYPES = new Set(['PROG', 'CLAS', 'FUGR', 'INTF']);
/** Types supported by ADT usageReferences (where-used). Sub-typed objects (e.g. PROG/I) are excluded dynamically. */
const WHERE_USED_TYPES = new Set(['PROG', 'CLAS', 'FUGR', 'INTF']);
/** Sub-program variants that have no standalone metadata or where-used support. */
const EXCLUDED_SUBTYPES = new Set(['I', 'S', 'M', 'F', 'K', 'J']);
const PREFIXES: Array<'Z*' | 'Y*'> = ['Z*', 'Y*'];

// ── XML helpers ───────────────────────────────────────────────────────────────

function xmlAttr(xml: string, attr: string): string {
  const m = xml.match(new RegExp(`${attr}="([^"]+)"`));
  return m ? m[1] : '';
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function cleanObjectName(name: string): string {
  return decodeXml(name)
    .trim()
    .replace(/^['"`]|['"`]$/g, '')
    .replace(/[.,;:)]+$/g, '')
    .toUpperCase();
}

function cleanObjectType(type: string): string {
  return decodeXml(type).trim().split('/')[0].toUpperCase();
}

function parseXmlAttributes(attrs: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  const re = /([\w:-]+)\s*=\s*["']([^"']*)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrs)) !== null) {
    parsed[m[1].toLowerCase()] = decodeXml(m[2]);
  }
  return parsed;
}

function readAttribute(attrs: Record<string, string>, names: string[]): string {
  for (const name of names) {
    const exact = attrs[name.toLowerCase()];
    if (exact) return exact;
  }

  for (const [key, value] of Object.entries(attrs)) {
    const localName = key.includes(':') ? key.split(':').pop() : key;
    if (localName && names.some(name => name.toLowerCase().split(':').pop() === localName)) {
      return value;
    }
  }

  return '';
}

function inferReferenceFromUri(uri: string): Partial<DependencyReference> {
  const decodedUri = decodeURIComponent(decodeXml(uri));
  const patterns: Array<{ type: string; re: RegExp }> = [
    { type: 'PROG', re: /\/programs\/programs\/([^/?#]+)/i },
    { type: 'CLAS', re: /\/oo\/classes\/([^/?#]+)/i },
    { type: 'INTF', re: /\/oo\/interfaces\/([^/?#]+)/i },
    { type: 'FUGR', re: /\/functions\/groups\/([^/?#]+)/i },
    { type: 'FUNC', re: /\/functions\/modules\/([^/?#]+)/i },
    { type: 'TABL', re: /\/dictionary\/tables\/([^/?#]+)/i },
    { type: 'DTEL', re: /\/dictionary\/dataelements\/([^/?#]+)/i },
    { type: 'DOMA', re: /\/dictionary\/domains\/([^/?#]+)/i },
  ];

  for (const pattern of patterns) {
    const match = decodedUri.match(pattern.re);
    if (match) {
      return { name: cleanObjectName(match[1]), type: pattern.type, uri: decodedUri };
    }
  }

  const repositoryMatch = decodedUri.match(/\/repository\/objects\/(?:R3TR\/)?([^/?#]+)\/([^/?#]+)/i);
  if (repositoryMatch) {
    return {
      type: cleanObjectType(repositoryMatch[1]),
      name: cleanObjectName(repositoryMatch[2]),
      uri: decodedUri,
    };
  }

  return uri ? { uri: decodedUri } : {};
}

function referenceFromAttributes(attrsText: string): DependencyReference | undefined {
  const attrs = parseXmlAttributes(attrsText);
  const uri = readAttribute(attrs, ['adtcore:uri', 'uri', 'href', 'link']);
  const inferred = uri ? inferReferenceFromUri(uri) : {};
  const name = cleanObjectName(
    readAttribute(attrs, ['adtcore:name', 'name', 'objectName', 'displayName']) || inferred.name || ''
  );
  const type = cleanObjectType(
    readAttribute(attrs, ['adtcore:type', 'type', 'objectType']) || inferred.type || 'UNKNOWN'
  );

  if (!name) return undefined;

  return {
    name,
    type,
    uri: uri || inferred.uri,
    packageName: readAttribute(attrs, ['adtcore:packageName', 'packageName']) || undefined,
    description: readAttribute(attrs, ['adtcore:description', 'description']) || undefined,
  };
}

/**
 * Parse ADT quick-search XML into a flat list of objects.
 * Each result element looks like:
 *   <adtcore:objectReference adtcore:name="Z_FOO" adtcore:type="PROG"
 *     adtcore:packageName="ZPKG" adtcore:description="..." />
 * (self-closing OR with closing tag on next line)
 */
function parseSearchResults(xml: string): Array<{ name: string; type: string; uri: string; packageName: string; description: string }> {
  const objects: Array<{ name: string; type: string; uri: string; packageName: string; description: string }> = [];
  // Match both self-closing tags and opening tags (SAP may vary)
  const re = /<adtcore:objectReference([^>]+?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const name = xmlAttr(attrs, 'adtcore:name');
    const type = xmlAttr(attrs, 'adtcore:type');
    if (!name || !type) continue;
    if (!name.startsWith('Z') && !name.startsWith('Y')) continue;
    objects.push({
      name,
      type,
      uri: xmlAttr(attrs, 'adtcore:uri'),   // exact URI SAP registered — use for where-used
      packageName: xmlAttr(attrs, 'adtcore:packageName'),
      description: xmlAttr(attrs, 'adtcore:description'),
    });
  }
  return objects;
}

/**
 * Count caller references in the ADT where-used XML response.
 *
 * SAP's numberOfResults attribute is UNRELIABLE — it often reports "1" even
 * when there are many callers. Instead we count actual usage markers:
 *
 *   1. gradeDirect  — direct references from external objects (most accurate)
 *   2. usageInformation (any) — includes gradeElement (methods/sections referenced)
 *   3. numberOfResults — SAP's own (often wrong) count, used only as last resort
 */
export function parseCallerCount(xml: string): number {
  // ── Strategy 1: Count gradeDirect references (actual external callers) ──
  const directCallers = xml.match(/usageInformation="gradeDirect[^"]*"/gi);
  if (directCallers && directCallers.length > 0) {
    return directCallers.length;
  }

  // ── Strategy 2: Count any usageInformation elements ─────────────────────
  // Includes gradeElement (referenced methods/sections) — better than nothing
  const allWithUsage = xml.match(/usageInformation="[^"]+"/gi);
  if (allWithUsage && allWithUsage.length > 0) {
    return allWithUsage.length;
  }

  // ── Strategy 3: numberOfResults (SAP's unreliable count, last resort) ───
  const nrMatch = xml.match(/numberOfResults="(\d+)"/);
  if (nrMatch) {
    return parseInt(nrMatch[1], 10);
  }

  // ── Strategy 4: Count all referencedObject elements ─────────────────────
  const allRefObjects = xml.match(/<(?:[\w-]+:)?referencedObject[\s>]/gi);
  if (allRefObjects && allRefObjects.length > 0) {
    return Math.max(0, allRefObjects.length - 1);
  }

  return 0;
}

function sameObject(left: DependencyReference, rightName: string, rightType: string): boolean {
  return left.name === cleanObjectName(rightName) && cleanObjectType(left.type) === cleanObjectType(rightType);
}

function dedupeReferences(refs: DependencyReference[]): DependencyReference[] {
  const seen = new Set<string>();
  const deduped: DependencyReference[] = [];
  for (const ref of refs) {
    const key = `${cleanObjectType(ref.type)}::${cleanObjectName(ref.name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...ref, name: cleanObjectName(ref.name), type: cleanObjectType(ref.type) });
  }
  return deduped;
}

/**
 * Extract direct caller objects from ADT where-used XML.
 * The XML shape differs across SAP releases, so this parser looks for any
 * object-reference-like tag and infers missing names/types from ADT URIs.
 */
export function parseWhereUsedReferences(xml: string, targetName: string, targetType: string): DependencyReference[] {
  const refs: DependencyReference[] = [];
  const tagRe = /<[^>]*(?:objectReference|referencedObject)[^>]*>/gi;
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(xml)) !== null) {
    const ref = referenceFromAttributes(m[0]);
    if (!ref) continue;
    if (sameObject(ref, targetName, targetType)) continue;
    refs.push(ref);
  }

  return dedupeReferences(refs);
}

function pushDependency(
  deps: ObjectDependency[],
  selfName: string,
  targetName: string,
  targetType: string,
  kind: DependencyKind,
  confidence: DependencyConfidence,
  rawText?: string
): void {
  const name = cleanObjectName(targetName);
  const type = cleanObjectType(targetType);
  if (!name || name === cleanObjectName(selfName)) return;
  if (!name.startsWith('Z') && !name.startsWith('Y')) return;

  deps.push({
    name,
    type,
    kind,
    source: 'SOURCE_PATTERN',
    confidence,
    rawText,
  });
}

function runDependencyPattern(
  deps: ObjectDependency[],
  source: string,
  selfName: string,
  pattern: RegExp,
  targetType: string,
  kind: DependencyKind,
  confidence: DependencyConfidence
): void {
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(source)) !== null) {
    pushDependency(deps, selfName, m[1], targetType, kind, confidence, m[0].trim());
  }
}

/**
 * Deterministic first-pass ABAP dependency extraction.
 * This catches common custom-object references without sending source code to AI.
 */
export function extractSourceDependencies(source: string, selfName: string): ObjectDependency[] {
  const deps: ObjectDependency[] = [];

  runDependencyPattern(deps, source, selfName, /\bCALL\s+FUNCTION\s+['"`]([ZY][A-Z0-9_/$-]+)['"`]/gi, 'FUNC', 'CALLS', 'high');
  runDependencyPattern(deps, source, selfName, /\b(?:CALL\s+METHOD|NEW)\s+([ZY]CL[A-Z0-9_/$-]+)/gi, 'CLAS', 'CALLS', 'high');
  runDependencyPattern(deps, source, selfName, /\b([ZY]CL[A-Z0-9_/$-]+)\s*=>/gi, 'CLAS', 'CALLS', 'high');
  runDependencyPattern(deps, source, selfName, /\bSUBMIT\s+([ZY][A-Z0-9_/$-]+)/gi, 'PROG', 'CALLS', 'high');
  runDependencyPattern(deps, source, selfName, /\bPERFORM\b[\s\S]{0,120}?\bIN\s+PROGRAM\s+([ZY][A-Z0-9_/$-]+)/gi, 'PROG', 'CALLS', 'medium');
  runDependencyPattern(deps, source, selfName, /^\s*INCLUDE\s+([ZY][A-Z0-9_/$-]+)/gim, 'PROG', 'INCLUDES', 'high');
  runDependencyPattern(deps, source, selfName, /\b(?:FROM|JOIN|UPDATE|MODIFY|DELETE\s+FROM|INSERT\s+(?:INTO\s+)?)\s+([ZY][A-Z0-9_/$-]+)/gi, 'TABL', 'USES_TABLE', 'medium');
  runDependencyPattern(deps, source, selfName, /\b(?:GET\s+BADI|CALL\s+BADI)\s+([ZY][A-Z0-9_/$-]+)/gi, 'BADI', 'ENHANCES', 'medium');

  const keyed = new Map<string, ObjectDependency>();
  for (const dep of deps) {
    const key = `${dep.kind}::${dep.type}::${dep.name}`;
    const previous = keyed.get(key);
    if (!previous || previous.confidence !== 'high') {
      keyed.set(key, dep);
    }
  }

  return Array.from(keyed.values());
}

function shouldUseLlmDependencyExtraction(source: string, dependencies: ObjectDependency[]): boolean {
  const upper = source.toUpperCase();
  const dynamicPatterns = [
    /\bCALL\s+FUNCTION\s+(?!['"`])/,
    /\bCALL\s+METHOD\s+\(/,
    /\bCREATE\s+OBJECT\b[\s\S]{0,80}\bTYPE\s+\(/,
    /\bSELECT\b[\s\S]{0,160}\bFROM\s+\(/,
    /\b(?:UPDATE|MODIFY|DELETE\s+FROM|INSERT\s+INTO)\s+\(/,
    /\bPERFORM\s+\(/,
    /\bASSIGN\s+\(/,
    /\bDEFINE\b[\s\S]{0,300}\bEND-OF-DEFINITION\b/,
  ];

  if (dynamicPatterns.some(pattern => pattern.test(upper))) {
    return true;
  }

  return dependencies.length === 0 && countLoc(source) > 180;
}

export function extractAtcDependencies(findings: AtcFinding[], selfName: string): ObjectDependency[] {
  const dependencies: ObjectDependency[] = [];
  const self = cleanObjectName(selfName);

  for (const finding of findings || []) {
    const evidence = `${finding.checkId}: ${finding.message} ${finding.location ?? ''}`;
    const names = evidence.match(/\b(?:[ZY][A-Z0-9_/$-]+|CL_[A-Z0-9_/$-]+|IF_[A-Z0-9_/$-]+|BAPI_[A-Z0-9_/$-]+|BADI_[A-Z0-9_/$-]+)\b/gi) ?? [];

    for (const rawName of names) {
      const name = cleanObjectName(rawName);
      if (!name || name === self || !isLikelyAtcReferenceName(name)) continue;

      const type = inferAtcReferenceType(name, finding.message);
      const kind = inferAtcDependencyKind(type, finding);
      dependencies.push({
        name,
        type,
        kind,
        source: 'ATC_FINDING',
        confidence: 'high',
        rawText: evidence.slice(0, 300),
      });
    }
  }

  const seen = new Set<string>();
  return dependencies.filter(dep => {
    const key = `${dep.kind}::${dep.type}::${dep.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isLikelyAtcReferenceName(name: string): boolean {
  return /^(?:[ZY][A-Z0-9_/$-]+|CL_[A-Z0-9_/$-]+|IF_[A-Z0-9_/$-]+|BAPI_[A-Z0-9_/$-]+|BADI_[A-Z0-9_/$-]+)$/.test(name);
}

function inferAtcReferenceType(name: string, message: string): string {
  const upperMessage = message.toUpperCase();
  if (/^(?:ZCL_|YCL_|CL_)/.test(name)) return 'CLAS';
  if (/^(?:ZIF_|YIF_|IF_)/.test(name)) return 'INTF';
  if (/^BAPI_/.test(name)) return 'FUNC';
  if (/^BADI_/.test(name)) return 'BADI';
  if (/\b(?:TABLE|VIEW|DATABASE|SELECT|OPEN SQL)\b/.test(upperMessage)) return 'TABL';
  if (/\b(?:FUNCTION MODULE|CALL FUNCTION|RFC)\b/.test(upperMessage)) return 'FUNC';
  if (/\b(?:PROGRAM|REPORT|SUBMIT)\b/.test(upperMessage)) return 'PROG';
  return 'UNKNOWN';
}

function inferAtcDependencyKind(type: string, finding: AtcFinding): DependencyKind {
  const text = `${finding.checkId} ${finding.message}`.toUpperCase();
  if (type === 'TABL' || type === 'VIEW') return 'USES_TABLE';
  if (type === 'BADI' || /\b(?:BADI|ENHANCEMENT|USER EXIT|CUSTOMER EXIT|EXIT)\b/.test(text)) return 'ENHANCES';
  return 'CALLS';
}


/** Count non-empty lines of source code. */
export function countLoc(source: string): number {
  return source.split('\n').filter(l => l.trim().length > 0).length;
}

/**
 * Parse transport history XML for:
 * - Number of transports in the last 12 months
 * - Most recent change date
 */
export function parseTransportHistory(xml: string): {
  changesLast12Months: number;
  lastChangedDate: string;
} {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);

  let changesLast12Months = 0;
  let lastChangedDate = '';

  // Look for changedAt in both transport XML and object metadata XML
  const re = /(?:changedAt|adtcore:changedAt)="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const d = new Date(m[1]);
    if (isNaN(d.getTime())) continue;
    if (!lastChangedDate || d > new Date(lastChangedDate)) lastChangedDate = m[1];
    if (d >= cutoff) changesLast12Months++;
  }

  return { changesLast12Months, lastChangedDate };
}

// ── ObjectDiscovery ───────────────────────────────────────────────────────────

export class ObjectDiscovery {
  constructor(
    private client: AdtClient,
    private llmDependencyExtractor?: LlmDependencyExtractor
  ) { }

  /**
   * Enumerate all Z* and Y* custom objects, enrich each with LOC,
   * caller count and transport history, and return the full list.
   *
   * @param onProgress(current, total, objectName) — called for each object
   */
  async discoverAll(
    onProgress: (current: number, total: number, name: string) => void,
    log?: (msg: string) => void
  ): Promise<EnrichedObject[]> {

    const _log = log ?? ((msg: string) => console.log(msg));

    // 1. Collect raw objects across both prefixes, deduplicating by name+type
    const seen = new Set<string>();
    const raws: Array<{ name: string; type: string; uri: string; packageName: string; description: string }> = [];

    for (const prefix of PREFIXES) {
      let xml: string;
      try {
        xml = await this.client.searchObjects(prefix, OBJECT_TYPES);
      } catch (e: any) {
        _log(`[ObjectDiscovery] searchObjects(${prefix}) failed: ${e.message}`);
        continue; // tolerate partial failure
      }
      _log(`[ObjectDiscovery] searchObjects(${prefix}) returned ${xml.length} chars. Preview: ${xml.slice(0, 300)}`);
      const parsed = parseSearchResults(xml);
      _log(`[ObjectDiscovery] Parsed ${parsed.length} objects from ${prefix}`);
      for (const obj of parsed) {
        const key = `${obj.type}::${obj.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          raws.push(obj);
        }
      }
    }

    // Cap at 100 objects for a manageable scan time
    const slicedRaws = raws.slice(0, 100);

    const total = slicedRaws.length;
    const enriched: EnrichedObject[] = [];

    // 2. Enrich each object (non-critical calls are fire-and-forget)
    for (let i = 0; i < slicedRaws.length; i++) {
      const raw = slicedRaws[i];
      onProgress(i + 1, total, raw.name);

      let callerCount = 0;
      let changesLast12Months = 0;
      let lastChangedDate = '';   // empty = unknown, not "today"
      let loc = 0;
      let callers: DependencyReference[] = [];
      let dependencies: ObjectDependency[] = [];

      // Only attempt where-used for types the SAP ADT endpoint supports
      const baseType = raw.type.split('/')[0];
      const subType = raw.type.split('/')[1] ?? '';
      // DIAG: always log first 10 objects so we can see their types and whether they pass the filter
      if (i < 10) {
        _log(`[DIAG object] i=${i} name=${raw.name} type=${raw.type} baseType=${baseType} subType="${subType}" passesFilter=${WHERE_USED_TYPES.has(baseType) && !EXCLUDED_SUBTYPES.has(subType)}`);
      }
      if (WHERE_USED_TYPES.has(baseType) && !EXCLUDED_SUBTYPES.has(subType)) {
        try {
          const whereUsedXml = await this.client.getWhereUsed(raw.name, baseType, raw.uri);
          if (whereUsedXml) {
            callers = parseWhereUsedReferences(whereUsedXml, raw.name, baseType);
            callerCount = callers.length > 0 ? callers.length : parseCallerCount(whereUsedXml);
            if (i < 10) {
              _log(`[DIAG where-used] ${raw.name} (${raw.type}) → callerCount=${callerCount} | XML preview: ${whereUsedXml.slice(0, 400)}`);
            }
          }
        } catch (e: any) {
          _log(`[ObjectDiscovery] where-used failed for ${raw.name}: ${e.message?.slice(0, 500)}`);
        }
      }

      try {
        const xml = await this.client.getTransportHistory(raw.name, raw.type, raw.uri);
        const parsed = parseTransportHistory(xml);
        changesLast12Months = parsed.changesLast12Months;
        if (parsed.lastChangedDate) lastChangedDate = parsed.lastChangedDate;
      } catch (e: any) {
        // Silently skip sub-typed objects with no standalone metadata endpoint
        if (!e.message?.includes('has no standalone metadata endpoint')) {
          _log(`[ObjectDiscovery] transport-history failed for ${raw.name}: ${e.message?.slice(0, 500)}`);
        }
      }

      if (SOURCE_TYPES.has(baseType) && !EXCLUDED_SUBTYPES.has(subType)) {
        try {
          const src = await this.client.getSourceCode(raw.type, raw.name);
          loc = countLoc(src);
          dependencies = extractSourceDependencies(src, raw.name);
          if (this.llmDependencyExtractor && shouldUseLlmDependencyExtraction(src, dependencies)) {
            try {
              const llmDependencies = await this.llmDependencyExtractor(src, raw);
              if (llmDependencies.length > 0) {
                dependencies = dependencies.concat(llmDependencies);
                _log(`[ObjectDiscovery] LLM extracted ${llmDependencies.length} dependencies for ${raw.name}`);
              }
            } catch (e: any) {
              _log(`[ObjectDiscovery] LLM dependency extraction failed for ${raw.name}: ${e.message?.slice(0, 300)}`);
            }
          }
        } catch { /* non-critical */ }
      }

      enriched.push({
        ...raw,
        callerCount,
        calleeCount: 0,   // filled after graph construction
        callers,
        dependencies,
        graphDepth: 0,
        changesLast12Months,
        lastChangedDate,
        loc,
        // Filled by later phases
        classification: undefined,
        atcFindings: [],
        atcFindingsCount: 0,
        modType: undefined,
        crvEntry: undefined,       // filled by CrvDatastore (P4)
        debtScore: undefined,
        effortSP: undefined,
        riskScore: undefined,
        riskLevel: undefined,
        riskDimensions: undefined,
        riskAdvisory: undefined,
      });
    }

    return enriched;
  }
}
