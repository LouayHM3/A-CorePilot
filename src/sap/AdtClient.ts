import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

export interface AdtConfig {
  host: string;
  client: string;
  username: string;
  password: string;
}

export interface AdtObject {
  name: string;
  type: string;           // PROG, CLAS, FUGR, INTF, TABL, DTEL, DOMA, MSAG
  packageName: string;
  description: string;
}

export interface VerifiedDependencyRelation {
  sourceName: string;
  sourceClass: string;
  targetName: string;
  targetClass: string;
  relationKind: string;
  sourceLine: number;
  evidence: string;
  verified: boolean;
}

export interface VerifiedUsedByResponse {
  objectName: string;
  objectClass: string;
  status: 'SUCCESS' | 'FAILED' | 'UNSUPPORTED' | 'NOT_FOUND';
  message: string;
  usedByCount: number;
  relations: VerifiedDependencyRelation[];
}

interface HttpResult {
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

export class AdtClient {
  private csrfToken: string | null = null;
  private readonly baseUrl: URL;
  private readonly authHeader: string;
  private readonly sapClient: string;
  /** Simple cookie jar: name → value */
  private cookies: Map<string, string> = new Map();

  constructor(config: AdtConfig) {
    this.baseUrl = new URL(config.host);
    this.sapClient = config.client;
    this.authHeader = 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64');
  }

  // ── Low-level HTTP ──────────────────────────────────────────────────────

  private request(
    method: string,
    path: string,
    body?: string,
    extraHeaders?: Record<string, string>
  ): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const isHttps = url.protocol === 'https:';

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        // SAP dev/test systems commonly use self-signed certificates
        rejectUnauthorized: false,
        headers: {
          'Authorization': this.authHeader,
          'sap-client': this.sapClient,
          'Accept': 'application/xml',
          ...(this.cookies.size > 0 ? {
            'Cookie': Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; '),
          } : {}),
          ...(body ? {
            'Content-Type': 'application/xml',
            'Content-Length': Buffer.byteLength(body),
          } : {}),
          ...(this.csrfToken ? { 'X-CSRF-Token': this.csrfToken } : {}),
          ...extraHeaders,
        },
      };

      const transport = isHttps ? https : http;
      const req = transport.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          // Capture Set-Cookie headers to maintain the SAP session
          const setCookie = res.headers['set-cookie'];
          if (setCookie) {
            for (const raw of setCookie) {
              const [pair] = raw.split(';');
              const eqIdx = pair.indexOf('=');
              if (eqIdx > 0) {
                this.cookies.set(pair.slice(0, eqIdx).trim(), pair.slice(eqIdx + 1).trim());
              }
            }
          }
          resolve({
            statusCode: res.statusCode ?? 0,
            body: data,
            headers: res.headers as Record<string, string | string[] | undefined>,
          });
        });
      });

      req.on('error', (err: any) => {
        if (err.message && err.message.includes('WRONG_VERSION_NUMBER')) {
          err.message = `Protocol mismatch. You're using 'https://' but the server is responding with HTTP. Please change the SAP Host URL in settings to 'http://' or use the correct HTTPS port. Original error: ${err.message}`;
        }
        reject(err);
      });
      if (body) req.write(body);
      req.end();
    });
  }

  // ── CSRF Token ──────────────────────────────────────────────────────────

  async fetchCsrfToken(): Promise<void> {
    if (this.csrfToken) return; // already cached
    const result = await this.request('GET', '/sap/bc/adt/discovery', undefined, {
      'X-CSRF-Token': 'Fetch',
      'Accept': 'application/atomsvc+xml',
    });
    const token = result.headers['x-csrf-token'];
    if (typeof token === 'string') {
      this.csrfToken = token;
    }
  }

  // ── Health Check ────────────────────────────────────────────────────────

  async ping(): Promise<boolean> {
    const result = await this.request('GET', '/sap/bc/adt/discovery', undefined, {
      'Accept': 'application/atomsvc+xml',
    });
    return result.statusCode === 200;
  }

  // ── Object Search ───────────────────────────────────────────────────────

  /**
   * Searches ADT for Z* or Y* objects of the given types.
   * Returns raw XML string.
   */
  async searchObjects(prefix: 'Z*' | 'Y*', objectTypes: string[]): Promise<string> {
    // Repeated objectType params — ADT rejects comma-separated values
    const typeParams = objectTypes.map(t => `objectType=${encodeURIComponent(t)}`).join('&');
    const path =
      `/sap/bc/adt/repository/informationsystem/search` +
      `?operation=quickSearch&query=${encodeURIComponent(prefix)}&${typeParams}&maxResults=500`;

    // This SAP system's search endpoint requires application/xml
    const result = await this.request('GET', path, undefined, {
      'Accept': 'application/xml',
    });
    if (result.statusCode !== 200) {
      throw new Error(`ADT search failed (${result.statusCode}): ${result.body.slice(0, 500)}`);
    }
    return result.body;
  }

  // ── Source Code ─────────────────────────────────────────────────────────

  async getSourceCode(objectType: string, objectName: string): Promise<string> {
    // Strip subtype suffix (e.g. PROG/P → PROG, PROG/I → PROG)
    const baseType = objectType.split('/')[0];
    const typePathMap: Record<string, string> = {
      PROG: `programs/programs/${encodeURIComponent(objectName)}`,
      CLAS: `oo/classes/${encodeURIComponent(objectName)}`,
      FUGR: `functions/groups/${encodeURIComponent(objectName)}`,
      INTF: `oo/interfaces/${encodeURIComponent(objectName)}`,
    };
    const typePath =
      typePathMap[baseType] ??
      `repository/objects/${baseType}/${encodeURIComponent(objectName)}`;

    // Source code is returned as plain text
    const result = await this.request('GET', `/sap/bc/adt/${typePath}/source/main`, undefined, {
      'Accept': 'text/plain',
    });
    return result.body;
  }

  // ── Where-Used ──────────────────────────────────────────────────────────

  async getWhereUsed(objectName: string, objectType: string, resolvedUri?: string): Promise<string> {
    // Use the exact ADT URI from search results if available (avoids 400s from URI mismatches).
    // Fall back to reconstructing it for callers that don't supply one.
    let objectUri: string;
    if (resolvedUri) {
      // resolvedUri from SAP search results is already the full path, e.g.
      // "/sap/bc/adt/programs/programs/Z01_DEMO_ALV_PDF"
      objectUri = resolvedUri;
    } else {
      const baseType = objectType.split('/')[0];
      const typePathMap: Record<string, string> = {
        PROG: `programs/programs/${encodeURIComponent(objectName)}`,
        CLAS: `oo/classes/${encodeURIComponent(objectName)}`,
        FUGR: `functions/groups/${encodeURIComponent(objectName)}`,
        INTF: `oo/interfaces/${encodeURIComponent(objectName)}`,
      };
      const typePath = typePathMap[baseType] ?? `repository/objects/${baseType}/${encodeURIComponent(objectName)}`;
      objectUri = `/sap/bc/adt/${typePath}`;
    }

    // ── Strategy 1: GET (works on some SAP systems) ─────────────────────────
    // Supply both objectUri and uri as query parameters, as different SAP versions
    // expect different parameter names.
    const getPath = `/sap/bc/adt/repository/informationsystem/usageReferences?objectUri=${encodeURIComponent(objectUri)}&uri=${encodeURIComponent(objectUri)}`;
    const getResult = await this.request('GET', getPath, undefined, {
      'Accept': 'application/xml',
    });
    if (getResult.statusCode === 200) {
      return getResult.body;
    }

    // ── Strategy 2: POST (required on many SAP systems) ──────────────────────
    // ADT usageReferences expects a single <objectReference> element (NOT wrapped
    // in <objectReferences>) with the full ADT URI of the object.
    await this.fetchCsrfToken();
    if (getResult.statusCode === 405 || getResult.statusCode === 400) {
      // Correct ADT body: usageReferenceRequest containing the objectReference
      const body =
        `<?xml version="1.0" encoding="utf-8"?>\n` +
        `<ris:usageReferenceRequest xmlns:ris="http://www.sap.com/adt/ris/usageReferences" xmlns:adtcore="http://www.sap.com/adt/core">\n` +
        `  <adtcore:objectReference adtcore:uri="${objectUri}"/>\n` +
        `</ris:usageReferenceRequest>`;

      // Pass the uri parameter in the POST url as well, as some backends require it there
      const postPath = `/sap/bc/adt/repository/informationsystem/usageReferences?uri=${encodeURIComponent(objectUri)}`;

      // Try with the specific SAP ADT vendor content type first
      let postResult = await this.request('POST', postPath, body, {
        'Accept': 'application/vnd.sap.adt.repository.usagereferences.result.v1+xml',
        'Content-Type': 'application/vnd.sap.adt.repository.usagereferences.request.v1+xml',
      });
      // If server rejects the vendor MIME type, retry with generic XML for Content-Type
      // but keep the specific Accept header as requested by the server
      if (postResult.statusCode === 415 || postResult.statusCode === 406) {
        postResult = await this.request('POST', postPath, body, {
          'Accept': 'application/vnd.sap.adt.repository.usagereferences.result.v1+xml',
          'Content-Type': 'application/xml',
        });
      }
      if (postResult.statusCode === 200) {
        return postResult.body;
      }
      throw new Error(`Where-used POST failed (${postResult.statusCode}): ${postResult.body.slice(0, 500)}`);
    }

    throw new Error(`Where-used failed (${getResult.statusCode}): ${getResult.body.slice(0, 500)}`);
  }

  /**
   * Query the customer-owned SAP repository wrapper. Unlike ADT's generic
   * usageReferences response, this endpoint returns normalized caller
   * identities and an explicit scan status. A numeric zero is trustworthy
   * only when status is SUCCESS.
   */
  async getVerifiedUsedBy(
    objectName: string,
    objectClass = 'REPS'
  ): Promise<VerifiedUsedByResponse> {
    const path =
      `/zacore/dependencies?objectName=${encodeURIComponent(objectName)}` +
      `&objectClass=${encodeURIComponent(objectClass)}`;
    const result = await this.request('GET', path, undefined, {
      'Accept': 'application/json',
    });

    if (result.statusCode !== 200 && result.statusCode !== 404 && result.statusCode !== 422) {
      throw new Error(`A-Core dependency API failed (${result.statusCode}): ${result.body.slice(0, 500)}`);
    }

    let parsed: VerifiedUsedByResponse;
    try {
      parsed = JSON.parse(result.body) as VerifiedUsedByResponse;
    } catch {
      throw new Error(`A-Core dependency API returned invalid JSON: ${result.body.slice(0, 300)}`);
    }

    if (!parsed || typeof parsed.status !== 'string') {
      throw new Error('A-Core dependency API returned an unusable response.');
    }

    // /UI2/CL_JSON with compression may omit an initial internal table.
    // SUCCESS without a relations property is a verified empty result.
    if (parsed.relations === undefined && parsed.status === 'SUCCESS') {
      parsed.relations = [];
    }
    if (!Array.isArray(parsed.relations)) {
      throw new Error('A-Core dependency API returned an unusable relations payload.');
    }

    return parsed;
  }

  // ── Transport History ───────────────────────────────────────────────────

  /**
   * Read object metadata XML to extract changedAt date.
   * The /vit/wb/object/workbench/ endpoint is not universally available;
   * reading the object itself is the reliable alternative.
   */
  async getTransportHistory(objectName: string, objectType: string, resolvedUri?: string): Promise<string> {
    const baseType = objectType.split('/')[0];
    const subType = objectType.split('/')[1] ?? '';

    // Include programs (PROG/I), module pools sub-includes, etc. are not
    // standalone objects and have no own properties endpoint — skip them.
    const STANDALONE_SUBTYPES_EXCLUDED = ['I', 'S', 'M', 'F', 'K', 'J'];
    if (STANDALONE_SUBTYPES_EXCLUDED.includes(subType)) {
      throw new Error(`Subtype ${objectType} has no standalone metadata endpoint`);
    }

    let objectUri: string;
    if (resolvedUri) {
      objectUri = resolvedUri;
    } else {
      const typePathMap: Record<string, string> = {
        PROG: `programs/programs/${encodeURIComponent(objectName)}`,
        CLAS: `oo/classes/${encodeURIComponent(objectName)}`,
        FUGR: `functions/groups/${encodeURIComponent(objectName)}`,
        INTF: `oo/interfaces/${encodeURIComponent(objectName)}`,
        TABL: `dictionary/tables/${encodeURIComponent(objectName)}`,
        DTEL: `dictionary/dataelements/${encodeURIComponent(objectName)}`,
        DOMA: `dictionary/domains/${encodeURIComponent(objectName)}`,
      };
      const typePath = typePathMap[baseType] ?? `repository/objects/${baseType}/${encodeURIComponent(objectName)}`;
      objectUri = `/sap/bc/adt/${typePath}`;
    }

    // Use */* to accept whatever format SAP returns for this object type
    const result = await this.request('GET', objectUri, undefined, {
      'Accept': '*/*',
    });
    if (result.statusCode !== 200) {
      throw new Error(`Object metadata failed (${result.statusCode}): ${result.body.slice(0, 200)}`);
    }
    return result.body;
  }

  // ── ATC ─────────────────────────────────────────────────────────────────

  /**
   * Step 1 of 2: Create an ATC worklist.
   *
   * SAP ADT requires a worklist to exist before a run can be created.
   * Returns the worklist ID extracted from the Location header.
   * The worklist ID must be supplied to createAtcRun as the `worklistId` param.
   */
  async createAtcWorklist(checkVariant?: string): Promise<string | undefined> {
    await this.fetchCsrfToken();

    // SAP ADT requires an empty worklist body (application/xml)
    const body =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<worklist:worklist xmlns:worklist="http://www.sap.com/adt/atc/worklist"\n` +
      `                   xmlns:adtcore="http://www.sap.com/adt/core"\n` +
      `                   worklist:id=""\n` +
      `                   worklist:timestamp=""\n` +
      `                   worklist:usedObjectSet="99999"\n` +
      `                   worklist:objectSetIsComplete="true">\n` +
      `  <worklist:objectSets>\n` +
      `    <worklist:objectSet worklist:kind="inclusive" worklist:id="99999" worklist:title="All Objects" worklist:numberOfObjects="0"/>\n` +
      `  </worklist:objectSets>\n` +
      `</worklist:worklist>`;

    console.log('[ATC] POST /sap/bc/adt/atc/worklists — creating worklist');

    const headers: Record<string, string> = {
      'Accept': 'application/vnd.sap.adt.atc.worklist.v1+xml, application/vnd.sap.adt.atc.worklists.v1+xml, application/xml, */*',
      'Content-Type': 'application/vnd.sap.adt.atc.worklist.v1+xml'
    };

    const query = checkVariant ? `?checkVariant=${encodeURIComponent(checkVariant)}` : '';
    let result = await this.request('POST', `/sap/bc/adt/atc/worklists${query}`, body, headers);

    // If SAP rejects the vendor content type, fallback to application/xml
    if (result.statusCode === 415 || result.statusCode === 406) {
      const fallbackHeaders: Record<string, string> = {
        'Accept': 'application/vnd.sap.adt.atc.worklist.v1+xml, application/vnd.sap.adt.atc.worklists.v1+xml, application/xml, */*',
        'Content-Type': 'application/xml'
      };
      result = await this.request('POST', `/sap/bc/adt/atc/worklists${query}`, body, fallbackHeaders);
    }

    const checkSuccess = (res: any): string | undefined => {
      if (res.statusCode === 200 || res.statusCode === 201) {
        const location = res.headers['location'];
        if (location && typeof location === 'string') {
          const match = location.match(/\/worklists\/([0-9A-Fa-f]{32})/i);
          if (match && match[1] !== '00000000000000000000000000000000') {
            return match[1];
          }
        }
        if (res.body && res.body.trim().length > 0) {
          const bodyId = res.body.trim();
          // Typically a 32 character hex string
          if (/^[A-Fa-f0-9]{32}$/.test(bodyId) && bodyId !== '00000000000000000000000000000000') {
            return bodyId;
          }
        }
      }
      return undefined;
    };

    let worklistId = checkSuccess(result);
    if (worklistId) {
      console.log(`[ATC] Worklist created with ID: ${worklistId}`);
      return worklistId;
    }

    // Some SAP systems accept an empty body for worklist creation
    console.warn(`[ATC] Worklist creation with body returned ${result.statusCode}, retrying with empty body...`);
    const retryHeaders: Record<string, string> = {
      'Accept': 'application/vnd.sap.adt.atc.worklist.v1+xml, application/vnd.sap.adt.atc.worklists.v1+xml, application/xml, */*',
      // Content-Type will be omitted by request() if body is empty, or we can force it:
      'Content-Type': 'application/xml'
    };
    const retry = await this.request('POST', `/sap/bc/adt/atc/worklists${query}`, '', retryHeaders);

    worklistId = checkSuccess(retry);
    if (worklistId) {
      console.log(`[ATC] Worklist created with ID: ${worklistId}`);
      return worklistId;
    }

    console.warn(`[ATC] Could not create specific worklist (got zero-GUID or error ${retry.statusCode}). SAP will use the global worklist.`);
    return undefined;
  }

  /**
   * Step 2 of 2: Create an ATC run referencing an existing worklist.
   *
   * SAP ADT requires worklistId as a query param — missing it causes
   * "Parameter worklistId could not be found" (400).
   * Returns the run ID extracted from the Location header.
   */
  /**
   * Result of createAtcRun — both the run ID (for polling) and the
   * result worklist ID (for fetching findings).
   *
   * SAP writes findings into a SPECIFIC worklist whose ID it embeds in the run
   * response body (href or XML attribute).  This is often DIFFERENT from the
   * global zero-GUID worklist that the Location header /runs/000...000 points to.
   * Callers MUST use resultWorklistId (when present) to fetch findings, otherwise
   * they end up reading the global shared worklist which contains other users'
   * results from previous runs.
   */
  async createAtcRun(
    objectName: string,
    objectType: string,
    objectUri: string,
    worklistId?: string,
    checkVariant?: string,
    targetRelease?: string
  ): Promise<{ runId: string; resultWorklistId?: string }> {
    await this.fetchCsrfToken();

    let resolvedUri = objectUri;
    const baseType = objectType.split('/')[0];
    if (!resolvedUri) {
      resolvedUri = `/sap/bc/adt/atc/objects/R3TR/${baseType}/${encodeURIComponent(objectName.toUpperCase())}`;
    }

    const runAttrs = checkVariant ? ` checkVariant="${checkVariant}"` : '';

    const body =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<atc:run${runAttrs} xmlns:atc="http://www.sap.com/adt/atc">\n` +
      `  <objectSets xmlns:adtcore="http://www.sap.com/adt/core">\n` +
      `    <objectSet kind="inclusive">\n` +
      `      <adtcore:objectReferences>\n` +
      `        <adtcore:objectReference adtcore:uri="${resolvedUri}" adtcore:type="${objectType}" adtcore:name="${objectName}"/>\n` +
      `      </adtcore:objectReferences>\n` +
      `    </objectSet>\n` +
      `  </objectSets>\n` +
      `</atc:run>`;

    let queryParams = '';
    if (worklistId) {
      queryParams += `worklistId=${encodeURIComponent(worklistId)}`;
    }
    if (checkVariant) {
      queryParams += (queryParams ? '&' : '') + `checkVariant=${encodeURIComponent(checkVariant)}`;
    }
    if (targetRelease) {
      queryParams += (queryParams ? '&' : '') + `targetRelease=${encodeURIComponent(targetRelease)}`;
    }
    const path = `/sap/bc/adt/atc/runs${queryParams ? '?' + queryParams : ''}`;

    console.log(`[ATC] POST ${path} — uri="${resolvedUri}" type="${objectType}" variant="${checkVariant ?? 'none'}"`);
    console.log(`[ATC] Body sent:\n${body}`);

    const result = await this.request('POST', path, body);

    if (result.statusCode !== 200 && result.statusCode !== 201) {
      throw new Error(`ATC run creation failed (${result.statusCode}): ${result.body.slice(0, 500)}`);
    }

    console.log(`[ATC] Run creation status: ${result.statusCode}`);
    console.log(`[ATC] Run creation headers: ${JSON.stringify(result.headers)}`);
    if (result.body && result.body.length > 0) {
      console.log(`[ATC] Run response FULL body:\n${result.body}`);
    } else {
      console.log(`[ATC] Run response body is EMPTY`);
    }

    // --- Extract runId from Location header ---
    let runId: string | undefined;
    const location = result.headers['location'];
    if (location && typeof location === 'string') {
      const m = location.match(/\/runs\/([^/?]+)/);
      if (m) runId = m[1];
    }

    // --- Extract the ACTUAL result worklist ID from the response body ---
    //
    // SAP embeds the worklist where it wrote findings in several possible formats:
    //   <atc:worklist atc:id="REAL_GUID" .../>
    //   <atom:link href=".../worklists/REAL_GUID" rel="..."/>
    //   <atcworklist:worklistId>REAL_GUID</atcworklist:worklistId>
    //
    // This GUID is the one we must use to fetch findings — NOT the zero-GUID
    // from the Location header, and NOT the worklist we created in step 1
    // (SAP may re-use its own internal worklist instead).
    let resultWorklistId: string | undefined;
    if (result.body) {
      const patterns: RegExp[] = [
        // <atc:worklist atc:id="GUID" .../>  or  worklist:id="GUID"
        /(?:atc:worklist|worklist)[^>]+(?:atc:id|worklist:id|id)="([0-9A-Fa-f]{32})"/,
        // <atom:link href=".../worklists/GUID"
        /\/worklists\/([0-9A-Fa-f]{32})/,
        // <atcworklist:worklistId>GUID</atcworklist:worklistId>
        /<atcworklist:worklistId>([^<]+)<\/atcworklist:worklistId>/,
        // href="/sap/bc/adt/atc/worklists/GUID"
        /href="[^"]*\/worklists\/([0-9A-Fa-f]{32})"/,
      ];
      for (const pattern of patterns) {
        const m = result.body.match(pattern);
        if (m && m[1] && m[1] !== '00000000000000000000000000000000') {
          resultWorklistId = m[1];
          console.log(`[ATC] Extracted resultWorklistId from run body: ${resultWorklistId}`);
          break;
        }
      }
      if (!resultWorklistId) {
        console.warn('[ATC] Could not extract a non-zero resultWorklistId from run body — will use fallback fetch strategy');
      }
    }

    // --- Last resort: use the zero-GUID as runId ---
    //
    // SAP sometimes returns a plain 200/201 with no Location header and no body.
    // In that case the run was added to the global persistent worklist (000...000).
    // We must not throw here — the retry loop in AtcRunner will handle the
    // empty-findings case gracefully.
    if (!runId) {
      runId = '00000000000000000000000000000000';
      console.warn('[ATC] No runId found in Location header — using zero-GUID for synchronous run');
    }

    return { runId, resultWorklistId };
  }

  /** Poll an ATC run. Returns 'running' or 'completed'. Throws if failed. */
  async pollAtcRun(runId: string): Promise<'running' | 'completed'> {
    const result = await this.request('GET', `/sap/bc/adt/atc/runs/${runId}`);
    if (result.statusCode !== 200) {
      throw new Error(`Non-200 HTTP ${result.statusCode} for run ${runId}. Body: ${result.body.substring(0, 500)}`);
    }
    if (result.body.includes('completed')) return 'completed';
    if (result.body.includes('failed')) {
      // Extract the actual error message if SAP provided one in the XML
      let sapError = '';
      const errMatch = result.body.match(/<shortText[^>]*>(.*?)<\/shortText>/) || result.body.match(/<message[^>]*>(.*?)<\/message>/);
      if (errMatch) {
        sapError = ` SAP says: "${errMatch[1]}"`;
      }
      throw new Error(`SAP reported run ${runId} as failed.${sapError} Raw Body: ${result.body.substring(0, 500)}`);
    }
    return 'running';
  }

  async getAtcFindings(runId: string, worklistId?: string): Promise<string> {
    // Try the modern /results endpoint first (as per latest SAP ADT and AI integration standards)
    const resultsHeaders: Record<string, string> = {
      'Accept': 'application/xml, */*',
    };
    let resultsResp = await this.request('GET', `/sap/bc/adt/atc/runs/${runId}/results`, undefined, resultsHeaders);
    if (resultsResp.statusCode === 200) {
      console.log(`[ATC] Fetched findings from /results: status 200, length ${resultsResp.body.length}`);
      return resultsResp.body;
    }

    // Use specific ATC findings media types to avoid 406 Not Acceptable from custom variants
    const findingsHeaders: Record<string, string> = {
      'Accept': 'application/vnd.sap.adt.atc.findings.v1+xml, application/vnd.sap.adt.atc.findings+xml, application/xml, */*',
    };

    // For zero-GUIDs (synchronous runs), try the run endpoint first, then fall back to worklist
    let result = await this.request('GET', `/sap/bc/adt/atc/runs/${runId}/findings`, undefined, findingsHeaders);

    console.log(`[ATC] Fetched findings from run ${runId}: status ${result.statusCode}, length ${result.body.length}`);

    // For synchronous runs (runId 000...), the findings might not be available at the runs endpoint,
    // but rather at the original worklist endpoint or worklist findings endpoint.
    const isGlobalWorklist = worklistId === '00000000000000000000000000000000';
    if (result.statusCode === 404 && worklistId && !isGlobalWorklist) {
      console.warn(`[ATC] Findings for run ${runId} returned 404, trying worklist findings endpoint...`);
      console.log(`[ATC] /runs/${runId}/findings body: ${result.body.substring(0, 500)}`);
      result = await this.request('GET', `/sap/bc/adt/atc/worklists/${worklistId}/findings`, undefined, findingsHeaders);
      console.log(`[ATC] Fetched findings from worklist ${worklistId}/findings: status ${result.statusCode}, length ${result.body.length}`);
      console.log(`[ATC] /worklists/${worklistId}/findings preview: ${result.body.substring(0, 500)}`);
    }

    // If still 404 or empty objects, try paginated worklist details endpoint.
    // SAP paginates large worklists — ZABAPGIT_STANDALONE has ~6000 findings
    // but a single non-paginated fetch only returns ~3000. We must fetch all pages.
    // Note: we also paginate the zero-GUID global worklist when it returns findings.
    const fetchWorklistId = worklistId || '00000000000000000000000000000000';
    if (result.statusCode === 404 || result.body.includes('<atcworklist:objects/>')) {
      console.warn(`[ATC] Worklist findings empty or 404, trying paginated worklist details endpoint...`);
      result = await this.fetchWorklistPaginated(fetchWorklistId, findingsHeaders);
    }

    // If 406 Not Acceptable, retry with broader Accept header
    if (result.statusCode === 406) {
      console.warn(`[ATC] Findings fetch returned 406 Not Acceptable, retrying with application/xml...`);
      result = await this.request('GET', `/sap/bc/adt/atc/runs/${runId}/findings`, undefined, {
        'Accept': 'application/xml, */*',
      });
      console.log(`[ATC] Retried findings from run ${runId}: status ${result.statusCode}, length ${result.body.length}`);
    }

    if (result.statusCode !== 200) {
      // If still failing, log the response for debugging
      console.error(`[ATC] Findings fetch failed (${result.statusCode}). Response:\n${result.body.slice(0, 500)}`);
      throw new Error(`ATC findings fetch failed (${result.statusCode})`);
    }
    return result.body;
  }

  /**
   * Fetch the full worklist, handling SAP server-side pagination.
   *
   * SAP caps worklist responses (typically ~3000-4000 findings per page).
   * We request subsequent pages via $skip/$top OData-style parameters until
   * SAP returns an empty objects page, signalling end of data.
   */
  private async fetchWorklistPaginated(
    worklistId: string,
    headers: Record<string, string>
  ): Promise<{ statusCode: number; body: string; headers: Record<string, string | string[] | undefined> }> {
    const PAGE_SIZE = 5000;
    let skip = 0;
    let allObjectsXml = '';
    let outerXml = '';
    let pageCount = 0;
    const MAX_PAGES = 20; // guard: max 100k findings

    while (pageCount < MAX_PAGES) {
      // First page: no $skip param for maximum compatibility with older SAP versions
      const paginatedPath = skip === 0
        ? `/sap/bc/adt/atc/worklists/${worklistId}`
        : `/sap/bc/adt/atc/worklists/${worklistId}?$skip=${skip}&$top=${PAGE_SIZE}`;

      const result = await this.request('GET', paginatedPath, undefined, headers);
      console.log(`[ATC] Worklist page ${pageCount + 1} (skip=${skip}): status ${result.statusCode}, length ${result.body.length}`);

      if (result.statusCode !== 200) {
        if (pageCount === 0) {
          return result; // First page failed — caller handles the error
        }
        break; // Subsequent page failed — return what we have
      }

      const objectsMatch = result.body.match(/<atcworklist:objects>([\s\S]*?)<\/atcworklist:objects>/);
      const pageObjectsXml = objectsMatch ? objectsMatch[1] : '';

      if (pageCount === 0) {
        outerXml = result.body;
        allObjectsXml = pageObjectsXml;
      } else {
        if (!pageObjectsXml.trim()) {
          console.log(`[ATC] Worklist pagination complete: no more findings at skip=${skip}`);
          break;
        }
        allObjectsXml += pageObjectsXml;
      }

      const objectCount = (result.body.match(/<atcobject:object /g) || []).length;
      console.log(`[ATC] Worklist page ${pageCount + 1}: ${objectCount} objects/findings`);

      pageCount++;
      skip += PAGE_SIZE;

      if (objectCount < PAGE_SIZE) {
        // Last page — fewer objects than page size means no more pages
        console.log(`[ATC] Worklist pagination complete: last page had ${objectCount} objects`);
        break;
      }
    }

    if (pageCount > 1) {
      const reassembled = outerXml.replace(
        /<atcworklist:objects>[\s\S]*?<\/atcworklist:objects>/,
        `<atcworklist:objects>${allObjectsXml}</atcworklist:objects>`
      );
      console.log(`[ATC] Reassembled worklist from ${pageCount} pages, total XML length: ${reassembled.length}`);
      return { statusCode: 200, body: reassembled, headers: {} };
    }

    return { statusCode: 200, body: outerXml, headers: {} };
  }
}

