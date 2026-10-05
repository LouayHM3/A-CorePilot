import { AdtClient } from './AdtClient';
import { AtcFinding } from './ObjectDiscovery';
import { XMLParser } from 'fast-xml-parser';

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 20; // 1 minute max per standalone object

// When SAP returns a zero-GUID runId it means the run was processed
// synchronously against the persistent global worklist. However, heavy
// checks (e.g. Clean Core cloudification checks that trigger P1) continue
// to execute asynchronously server-side and are NOT yet persisted when
// SAP sends the 200/201 response back.  We must wait and retry fetching
// until findings for the target object actually appear — or until timeout.
const ZERO_GUID_INITIAL_WAIT_MS  = 6000;  // initial grace period before first fetch
const ZERO_GUID_RETRY_INTERVAL_MS = 5000;  // interval between retries
const ZERO_GUID_MAX_RETRIES       = 4;     // max 20 s after the initial wait

// ── XML attribute helper ──────────────────────────────────────────────────────

function getAttr(attrsStr: string, name: string): string {
  const m = attrsStr.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : '';
}

// ── Format B: Checkstyle XML parser ──────────────────────────────────────────
//
// SAP commonly returns findings in checkstyle format when the Accept header
// falls back to application/xml or */*:
//
//   <checkstyle version="5.0">
//     <file name="PROG/ZPROG_FOO">
//       <error line="10" severity="error"   message="..." source="CHECK_ID"/>
//       <error line="20" severity="warning" message="..." source="CHECK_ID"/>
//       <error line="30" severity="info"    message="..." source="CHECK_ID"/>
//     </file>
//   </checkstyle>
//
// severity → ATC priority mapping:
//   error   → 1 (Clean Core Level D)
//   warning → 2 (Clean Core Level C)
//   info    → 3 (Clean Core Level B)

function parseCheckstyleFindings(xml: string, filterObjectName?: string): AtcFinding[] {
  const findings: AtcFinding[] = [];

  // Match each <file name="...">...</file> block
  const fileRe = /<file\s([^>]*)>([\s\S]*?)<\/file>/g;
  let fileMatch: RegExpExecArray | null;

  while ((fileMatch = fileRe.exec(xml)) !== null) {
    const fileAttrs = fileMatch[1];
    const fileContent = fileMatch[2];
    const fileName = getAttr(fileAttrs, 'name'); // e.g. "PROG/ZPROG_FOO"

    if (filterObjectName && !fileName.toUpperCase().endsWith('/' + filterObjectName.toUpperCase())) {
      continue;
    }

    // Match each <error .../> or <error ...></error> inside this file block
    const errorRe = /<error\s([^>]*?)\/?>/g;
    let errorMatch: RegExpExecArray | null;
    while ((errorMatch = errorRe.exec(fileContent)) !== null) {
      const attrs = errorMatch[1];
      const severity = getAttr(attrs, 'severity').toLowerCase();
      const message   = decodeHtml(getAttr(attrs, 'message'));
      const source    = getAttr(attrs, 'source');
      const line      = getAttr(attrs, 'line');

      // Map checkstyle severity → ATC priority (1=error, 2=warning, 3=info)
      const priority: 1 | 2 | 3 =
        severity === 'error'   ? 1 :
        severity === 'warning' ? 2 : 3;

      findings.push({
        checkId:  source,
        priority,
        message,
        location: line ? `${fileName}:${line}` : fileName,
      });
    }
  }

  console.log(`[ATC Checkstyle Parser] Parsed ${findings.length} findings for ${filterObjectName ?? '(all)'}`);
  if (findings.length > 0) {
    findings.slice(0, 3).forEach((f, i) => {
      console.log(`  [${i}] checkId=${f.checkId}, priority=${f.priority}, msg="${f.message.substring(0, 80)}"`);
    });
  }

  return findings;
}

// ── Format A: atcworklist namespaced XML parser ───────────────────────────────
//
// Some SAP versions return:
//   <atcworklist:worklist ...>
//     <atcworklist:objects>
//       <atcobject:object adtcore:name="ZPROG_FOO" ...>
//         <atcobject:findings>
//           <atcfinding:finding atcfinding:priority="1" atcfinding:shortDescription="..." .../>
//         </atcobject:findings>
//       </atcobject:object>
//     </atcworklist:objects>
//   </atcworklist:worklist>

function parseWorklistFindings(xml: string, filterObjectName?: string): AtcFinding[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    allowBooleanAttributes: true
  });

  const jsonObj = parser.parse(xml);
  const findings: AtcFinding[] = [];

  const worklist = jsonObj['atcworklist:worklist'];
  if (!worklist) {
    console.warn('[ATC Worklist Parser] No atcworklist:worklist root found in XML');
    return findings;
  }

  const objectsContainer = worklist['atcworklist:objects'];
  if (!objectsContainer) {
    console.warn('[ATC Worklist Parser] No atcworklist:objects found');
    return findings;
  }

  let objects = objectsContainer['atcobject:object'];
  if (!objects) {
    console.warn('[ATC Worklist Parser] No atcobject:object elements found');
    return findings;
  }
  if (!Array.isArray(objects)) {
    objects = [objects];
  }

  // Collect findings — from the matching object if a filter is given,
  // otherwise from ALL objects in the worklist.
  let findingItems: any[] = [];

  for (const obj of objects) {
    if (!obj) continue;

    const findingsContainer = obj['atcobject:findings'];
    if (!findingsContainer) continue;

    let objFindings = findingsContainer['atcfinding:finding'];
    if (!objFindings) continue;
    if (!Array.isArray(objFindings)) {
      objFindings = [objFindings];
    }

    // Attach parent object name to each finding so we can fallback to it
    const objName: string = obj['@_adtcore:name'] ?? '';
    for (const f of objFindings) {
      f._parentObjectName = objName;
    }

    findingItems = findingItems.concat(objFindings);
  }

  // No need to fallback since we collect all findings in the worklist anyway

  for (const item of findingItems) {
    if (!item || typeof item !== 'object') continue;

    // Check for exemption flags. If a finding is exempted/approved, skip it.
    const exemptionStatus = 
      item['@_atcfinding:exemptionApproval'] || 
      item['@_exemptionApproval'] || 
      item['@_atcfinding:isExempted'] || 
      item['@_isExempted'] || 
      '';
      
    if (exemptionStatus.toLowerCase() === 'approved' || exemptionStatus.toLowerCase() === 'true') {
      continue;
    }

    const priorityStr =
      item['@_atcfinding:priority'] ||
      item['@_priority'] ||
      '';

    if (!priorityStr) continue;

    const priority = parseInt(priorityStr, 10);
    const validPriority: 1 | 2 | 3 = (priority === 1 || priority === 2 || priority === 3) ? priority : 3;

    let message =
      item['@_atcfinding:messageTitle'] ||
      item['@_messageTitle'] ||
      item['@_atcfinding:shortDescription'] ||
      item['@_shortDescription'] ||
      item['@_description'] ||
      '';

    if (!message && item['atcfinding:message']) {
      message = typeof item['atcfinding:message'] === 'string'
        ? item['atcfinding:message']
        : (item['atcfinding:message']['#text'] ?? '');
    }

    message = decodeHtml(message);

    const checkId  = item['@_atcfinding:checkId']  || item['@_checkId']  || '';
    const location = item['@_atcfinding:location']  || item._parentObjectName || '';

    if (filterObjectName) {
      const upperLoc = location.toUpperCase();
      const upperFilter = filterObjectName.toUpperCase();
      const upperUrlEncodedFilter = encodeURIComponent(filterObjectName).toUpperCase();
      const upperParent = (item._parentObjectName || '').toUpperCase();

      if (upperParent !== upperFilter && !upperLoc.includes(upperFilter) && !upperLoc.includes(upperUrlEncodedFilter)) {
        continue;
      }
    }

    findings.push({ checkId, priority: validPriority, message, location });
  }

  console.log(`[ATC Worklist Parser] Parsed ${findings.length} findings for ${filterObjectName ?? '(all)'}`);
  if (findings.length > 0) {
    findings.slice(0, 3).forEach((f, i) => {
      console.log(`  [${i}] checkId=${f.checkId}, priority=${f.priority}, msg="${f.message.substring(0, 80)}"`);
    });
  }

  return findings;
}

// ── Format C: /results endpoint parser ───────────────────────────────────────
//
// Modern ADT REST APIs return findings via the /results endpoint:
//   <atc:result ...>
//     <atc:finding priority="1" messageTitle="..." location="..." checkId="..."/>
//   </atc:result>

function parseResultsFindings(xml: string, filterObjectName?: string): AtcFinding[] {
  const findings: AtcFinding[] = [];
  const findingRe = /<(?:atc:)?finding\s([^>]*?)\/?>/g;
  let findingMatch: RegExpExecArray | null;

  while ((findingMatch = findingRe.exec(xml)) !== null) {
    const attrs = findingMatch[1];
    
    // Check for exemption flags. If a finding is exempted/approved, skip it.
    const exemptionStatus = getAttr(attrs, 'exemptionApproval') || getAttr(attrs, 'isExempted') || '';
    if (exemptionStatus.toLowerCase() === 'approved' || exemptionStatus.toLowerCase() === 'true') {
      continue;
    }

    const priorityStr = getAttr(attrs, 'priority');
    const message = decodeHtml(getAttr(attrs, 'messageTitle') || getAttr(attrs, 'shortDescription') || '');
    const checkId = getAttr(attrs, 'checkId') || '';
    const location = getAttr(attrs, 'location') || '';

    if (filterObjectName) {
      const upperLoc = location.toUpperCase();
      const upperFilter = filterObjectName.toUpperCase();
      const upperUrlEncodedFilter = encodeURIComponent(filterObjectName).toUpperCase();
      // results parser doesn't easily have parent object name, so we rely on location matching
      if (!upperLoc.includes(upperFilter) && !upperLoc.includes(upperUrlEncodedFilter)) {
        continue;
      }
    }

    if (!priorityStr) continue;

    const priority = parseInt(priorityStr, 10);
    const validPriority: 1 | 2 | 3 = (priority === 1 || priority === 2 || priority === 3) ? priority : 3;

    findings.push({ checkId, priority: validPriority, message, location });
  }

  console.log(`[ATC Results Parser] Parsed ${findings.length} findings for ${filterObjectName ?? '(all)'}`);
  if (findings.length > 0) {
    findings.slice(0, 3).forEach((f, i) => {
      console.log(`  [${i}] checkId=${f.checkId}, priority=${f.priority}, msg="${f.message.substring(0, 80)}"`);
    });
  }

  return findings;
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

function parseFindings(xml: string, filterObjectName?: string): AtcFinding[] {
  if (filterObjectName) {
    filterObjectName = decodeHtml(filterObjectName);
  }

  if (!xml || xml.trim().length === 0) {
    console.warn('[ATC Parser] Received empty XML — no findings');
    return [];
  }

  // Keep production logs bounded; full ATC responses can be very large.
  console.log(`[ATC Parser] Raw XML preview: ${xml.substring(0, 400)}`);

  // SAP returns checkstyle format when Accept falls back to application/xml or */*
  if (xml.includes('<checkstyle')) {
    console.log('[ATC Parser] Detected checkstyle format — using checkstyle parser');
    return parseCheckstyleFindings(xml, filterObjectName);
  }

  // SAP returns namespaced worklist XML when Accept includes the atc vendor MIME types
  if (xml.includes('atcworklist:worklist') || xml.includes('atcworklist')) {
    console.log('[ATC Parser] Detected atcworklist format — using worklist parser');
    return parseWorklistFindings(xml, filterObjectName);
  }

  // Modern SAP ADT ATC REST APIs return <atc:result> or <atc:finding> from /results
  if (xml.includes('<atc:result') || xml.includes('<atc:finding') || xml.includes('<finding')) {
    console.log('[ATC Parser] Detected atc:finding format — using results parser');
    return parseResultsFindings(xml, filterObjectName);
  }

  // Unknown format — log and return empty so classification stays unclassified (-)
  // rather than incorrectly defaulting to Class A
  console.error(`[ATC Parser] Unknown XML format — cannot parse findings. Root element: ${xml.substring(0, 200)}`);
  return [];
}

function decodeHtml(str: string): string {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'");
}

// ── AtcRunner ────────────────────────────────────────────────────────────────

export class AtcRunner {
  constructor(private client: AdtClient) {}

  /**
   * Run ATC for a single object and return the findings.
   * Polls until completed or times out.
   */
  async runForObject(objectName: string, objectType: string, objectUri: string, checkVariant?: string, targetRelease?: string): Promise<AtcFinding[]> {
    if (!objectName) return [];

    console.log(`[ATC] Starting run for ${objectName} (type: ${objectType})`);
    
    // SAP ADT requires a worklist to exist before a run can be created on many systems.
    let worklistId: string | undefined = undefined;
    try {
      worklistId = await this.client.createAtcWorklist(checkVariant);
    } catch (e: any) {
      console.warn(`[ATC] Could not create worklist (some modern systems don't need it, but older ones do): ${e.message}`);
    }

    // Trigger the run for the specific object
    let runId: string;
    let resultWorklistId: string | undefined;
    try {
      const runResult = await this.client.createAtcRun(objectName, objectType, objectUri, worklistId, checkVariant, targetRelease);
      runId = runResult.runId;
      resultWorklistId = runResult.resultWorklistId;
      if (resultWorklistId) {
        console.log(`[ATC] SAP wrote results to specific worklist: ${resultWorklistId}`);
      }
    } catch (e: any) {
      if (checkVariant && checkVariant !== 'ZABAP_CLOUD_DEV_DEFAULT') {
        console.warn(`[ATC] Run failed with variant "${checkVariant}". Retrying with default variant "ZABAP_CLOUD_DEV_DEFAULT"... Error: ${e.message}`);
        try {
          const runResult = await this.client.createAtcRun(objectName, objectType, objectUri, worklistId, 'ZABAP_CLOUD_DEV_DEFAULT', targetRelease);
          runId = runResult.runId;
          resultWorklistId = runResult.resultWorklistId;
          if (resultWorklistId) {
            console.log(`[ATC] SAP wrote results to specific worklist: ${resultWorklistId}`);
          }
        } catch (retryError: any) {
          throw new Error(`ATC run creation failed with both "${checkVariant}" and default variant "ZABAP_CLOUD_DEV_DEFAULT": ${retryError.message}`);
        }
      } else {
        throw new Error(`ATC run creation failed for ${objectName}: ${e.message}`);
      }
    }

    // 3. Poll / wait
    let attempts = 0;
    let finalStatus = 'running';
    const isZeroGuid = runId === '00000000000000000000000000000000';

    if (isZeroGuid) {
      // SAP returned the zero-GUID.  This means the run was dispatched to the
      // global persistent worklist.  Heavy variant checks (like Clean Core P1
      // cloudification checks) may still be executing server-side.  We must
      // NOT fetch immediately — that would return the stale global worklist.
      // Instead, wait an initial grace period then poll until findings for the
      // specific object appear, or until we time out.
      console.log(`[ATC] Zero-GUID runId detected for ${objectName} — waiting ${ZERO_GUID_INITIAL_WAIT_MS}ms before first fetch (async checks may still be running)`);
      await sleep(ZERO_GUID_INITIAL_WAIT_MS);
      finalStatus = 'completed'; // Proceed to fetch phase below (with retry logic)
    } else {
      while (attempts < MAX_POLL_ATTEMPTS) {
        await sleep(POLL_INTERVAL_MS);
        const status = await this.client.pollAtcRun(runId);
        if (status === 'completed') {
          finalStatus = 'completed';
          break;
        }
        attempts++;
      }
    }

    if (finalStatus === 'failed') {
      throw new Error(`ATC run ${runId} failed for ${objectName}`);
    }

    if (!isZeroGuid && attempts >= MAX_POLL_ATTEMPTS) {
      throw new Error(`ATC run ${runId} timed out for ${objectName}`);
    }

    // 4. Fetch findings
    //    Priority order for the worklist to fetch:
    //      1. resultWorklistId — extracted from the run response body (most reliable: this is
    //         exactly where SAP wrote the findings for our specific run)
    //      2. worklistId — the worklist we pre-created (fallback)
    //      3. Zero-GUID passthrough — last resort, fetches the global shared worklist
    //
    //    For zero-GUID runs we also use a retry loop because heavy checks may still
    //    be running when SAP returns the 200/201.
    let xml: string;
    let findings: AtcFinding[] = [];

    // Prefer the result worklist from the run body over the pre-created worklist
    const findingsWorklistId = resultWorklistId || worklistId;
    // A dedicated worklist belongs only to this run, so retain findings from
    // included child objects too. Filter by name only for the shared fallback.
    const findingsFilter = findingsWorklistId ? undefined : objectName;

    if (isZeroGuid) {
      for (let retry = 0; retry <= ZERO_GUID_MAX_RETRIES; retry++) {
        try {
          xml = await this.client.getAtcFindings(runId, findingsWorklistId);
        } catch (e: any) {
          throw new Error(`Failed to fetch ATC findings for ${objectName}: ${e.message}`);
        }

        findings = parseFindings(xml, findingsFilter);
        console.log(`[ATC] Zero-GUID retry ${retry}/${ZERO_GUID_MAX_RETRIES}: ${findings.length} findings for ${objectName}`);

        if (findings.length > 0) {
          console.log(`[ATC] Findings appeared — waiting ${ZERO_GUID_RETRY_INTERVAL_MS}ms for remaining async checks before final fetch`);
          await sleep(ZERO_GUID_RETRY_INTERVAL_MS);
          try {
            xml = await this.client.getAtcFindings(runId, findingsWorklistId);
            findings = parseFindings(xml, findingsFilter);
          } catch (_) { /* keep what we already have */ }
          break;
        }

        if (retry < ZERO_GUID_MAX_RETRIES) {
          console.log(`[ATC] No findings yet for ${objectName} — retrying in ${ZERO_GUID_RETRY_INTERVAL_MS}ms`);
          await sleep(ZERO_GUID_RETRY_INTERVAL_MS);
        } else {
          console.warn(`[ATC] Zero-GUID fetch exhausted retries for ${objectName} — returning empty findings`);
        }
      }
    } else {
      try {
        xml = await this.client.getAtcFindings(runId, findingsWorklistId);
      } catch (e: any) {
        throw new Error(`Failed to fetch ATC findings for ${objectName}: ${e.message}`);
      }
      findings = parseFindings(xml, findingsFilter);
    }

    console.log(`[ATC] Successfully parsed ${findings.length} findings for ${objectName}`);
    return findings;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
