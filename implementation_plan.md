# A-CorePilot — SAP Clean Core Migration Assistant
## Implementation Plan v3 (Final)

---

## Overview

**A-CorePilot** is a VS Code extension embedding a multi-agent AI pipeline that helps SAP technical consultants migrate custom ABAP Z\*/Y\* objects to SAP Clean Core. 

---

## All Decisions Locked ✅

| Concern | Decision |
|---------|----------|
| IDE | **VS Code** extension — TypeScript + VS Code API |
| SAP Connectivity | **ADT REST API** (`/sap/bc/adt/`) — Basic Auth + CSRF token |
| LLM | **SAP AI Core** — OpenAI-compatible chat completions (credentials in VS Code settings per user) |
| Classification (A/B/C/D) | **Derived from ATC findings** — deterministic mapping by check ID + priority |
| Technical Debt Formula | **Hardcoded once** in `src/debt/DebtFormula.ts` — derived from Clean Core PDF criteria, no re-parsing at runtime |
| Cloudification Lookup | **Auto-updated** clone of `SAP/abap-atc-cr-cv-s4hc` on every startup — GitHub ZIP download, no git required |
| Export | **Local Markdown + JSON only** — `.corepilot/reports/migration-report.md` |
| Risk Score | **New 6-dimensional formula** — feeds both user dashboard and LLM decision gate |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         VS Code Extension                            │
│                                                                      │
│  ┌──────────────────┐   ┌────────────────────────────────────────┐  │
│  │   Sidebar Tree   │   │            Webview Dashboard            │  │
│  │  Z*/Y* Objects   │   │                                        │  │
│  │  [A][B][C][D]    │   │  ┌──────────────┐  ┌───────────────┐  │  │
│  │  badges + risk   │   │  │  Dependency  │  │  Migration    │  │  │
│  └──────────────────┘   │  │    Graph     │  │  Plan Board   │  │  │
│                          │  └──────────────┘  └───────────────┘  │  │
│                          │  ┌──────────────┐  ┌───────────────┐  │  │
│                          │  │ Object Detail│  │  Agent Stream │  │  │
│                          │  │ + Risk Panel │  │  (AI Chat)    │  │  │
│                          │  └──────────────┘  └───────────────┘  │  │
│                          └────────────────────────────────────────┘  │
│                                       │                              │
│               ┌───────────────────────▼──────────────────────┐      │
│               │              Agent Orchestrator               │      │
│               └───┬──────┬──────┬─────────┬──────┬───────────┘      │
│                   │      │      │         │      │                   │
│            ┌──────▼─┐ ┌──▼───┐ ┌▼──────┐ ┌▼─────────────────────┐ │
│            │Scanner │ │ ATC  │ │ Debt  │ │   Cloudification     │ │
│            │ Agent  │ │Agent │ │ Agent │ │       Agent          │ │
│            └────────┘ └──────┘ └───────┘ └──────────────────────┘ │
│                            ┌──────────────────────────────┐         │
│                            │    Migration Planner Agent    │         │
│                            └──────────────────────────────┘         │
│                                                                      │
│   ┌──────────────────────────────────────────────────────────────┐  │
│   │                       Shared Services                        │  │
│   │  AdtClient │ SapAiCoreService │ GraphEngine │ CrvDatastore   │  │
│   │            │                  │             │                │  │
│   │  DebtFormula (hardcoded)  │  RiskScorer (hardcoded)         │  │
│   └──────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
         │                    │                      │
   SAP System           SAP AI Core BTP       github.com/SAP/
  (ADT REST)           (LLM inference)    abap-atc-cr-cv-s4hc (ZIP)
```

---

## The Risk Score Formula (New — Fully Defined)

This is a **6-dimensional weighted formula** that produces a score from **0 to 100**. It is independent from the technical debt score and serves two purposes:
1. **User insight panel** — visualized per dimension as a radar chart in the dashboard
2. **LLM decision gate** — when Risk ≥ High, the full dimension breakdown is injected into the LLM prompt so it can reason about mitigation strategy rather than just generating a wrapper

### Dimensions

---

#### R₁ — Coupling Risk (weight: 0.25)
*How many other objects depend on this one? Changes here break the most things.*

```
callerCount  = number of objects that directly call this object (from where-used)
calleeCount  = number of external objects this object calls

couplingRaw  = (callerCount × 2) + calleeCount        // callers weighted more
R₁           = min(1.0,  couplingRaw / 40)            // normalized: 40 = saturation point
```

> Rationale: An object with 20 callers (score = 1.0) is maximally risky to touch. Callees count half because changing what you call is less disruptive than changing your interface.

---

#### R₂ — Complexity Risk (weight: 0.20)
*How hard is the object to understand and migrate correctly?*

```
loc          = lines of code (from ADT metadata)
findingCount = total ATC findings count
findingScore = Σ (finding.priority == 1 ? 3 : finding.priority == 2 ? 1.5 : 0.5)
               for all ATC findings

complexityRaw = (loc / 500) + (findingScore / 20)
R₂            = min(1.0, complexityRaw / 2)
```

> Rationale: 500 LOC is already complex for ABAP. ATC errors (priority 1) are weighted 3× more than warnings.

---

#### R₃ — Integration Exposure Risk (weight: 0.25)
*Is this object exposed externally (RFC, BAPI, IDoc, Web Service)? External consumers cannot be updated unilaterally.*

```
// Detected from source code pattern matching + ADT object type
isRfcEnabled   = source contains "FUNCTION ... REMOTE-ENABLED" → +4
isBapi         = object name matches BAPI_* pattern or is in BAPI discovery → +3
isIdocHandler  = contains IDOC processing FM calls or message type registration → +3
isWebService   = bound to SOAMANAGER / wsconfig → +3
isEnhancement  = is a BAdI implementation or User Exit → +2

exposureScore  = isRfcEnabled + isBapi + isIdocHandler + isWebService + isEnhancement
R₃             = min(1.0, exposureScore / 8)
```

> Rationale: RFC-enabled FMs and BAPIs are the hardest to migrate because external systems (non-SAP) may call them. BAdIs are slightly safer because the standard code owns the interface.

---

#### R₄ — Volatility Risk (weight: 0.10)
*How often has this object been changed recently? High change frequency = active business dependency.*

```
// From ADT object history or transport log (TADIR + E070/E071)
changesLast12Months = number of transport requests containing this object
                      in the last 12 months

R₄ = min(1.0, changesLast12Months / 12)   // monthly change = max risk
```

> Rationale: An object changed every month is actively maintained for business reasons — disrupting it has immediate operational impact.

---

#### R₅ — Modification Type Risk (weight: 0.15)
*What kind of custom object is this? Some types are inherently more fragile to migrate.*

```
// Determined by deterministic SAP metadata, ATC and ABAP source rules.
// Every result stores confidence, source and evidence; no LLM call is used for R5.
modType → riskMultiplier:

  CLASSICAL_MODIFICATION    → 1.0   // direct modification of SAP standard (most dangerous)
  IMPLICIT_ENHANCEMENT      → 0.85  // enhancement section inside standard code
  EXPLICIT_ENHANCEMENT      → 0.70  // PRE/POST exit in standard FM
  BADI_IMPLEMENTATION       → 0.55  // structured extension point (cleanest)
  CUSTOM_DEVELOPMENT        → 0.30  // fully custom Z object (no SAP standard touched)
  WRAPPER_PROXY             → 0.15  // already a wrapper around standard

R₅ = riskMultiplier  // directly normalized
```

> Rationale: Classical modifications break on every SAP upgrade. BAdI implementations survive because SAP owns the contract.

---

#### R₆ — Data Sensitivity Risk (weight: 0.05)
*Does this object access business-critical or regulated data tables?*

```
// Detected from source code: SELECT / INSERT / UPDATE / DELETE on known tables
sensitiveTableCategories:
  FINANCIAL  = { BKPF, BSEG, ACDOCA, SKA1, SKB1, ... }          → weight 3
  HR_PAYROLL = { PA0001, PA0008, T549Q, ... }                    → weight 3
  MATERIAL   = { MARA, MARC, MARD, EKKO, EKPO, ... }            → weight 2
  SALES      = { VBAK, VBAP, VBFA, KNA1, ... }                  → weight 2
  CUSTOMIZING= { T-tables, configuration customizing tables }    → weight 1

dataSensitivityRaw = Σ weight for each detected category (capped at 6)
R₆ = min(1.0, dataSensitivityRaw / 6)
```

> Rationale: Objects accessing financial or HR tables carry regulatory/audit risk — a bug during migration could corrupt books or violate GDPR.

---

### Final Risk Score

```
RiskScore = (
  0.25 × R₁  +   // Coupling
  0.20 × R₂  +   // Complexity
  0.25 × R₃  +   // Integration Exposure
  0.10 × R₄  +   // Volatility
  0.15 × R₅  +   // Modification Type
  0.05 × R₆      // Data Sensitivity
) × 100
```

### Risk Level Thresholds

| Score | Level | Badge | Meaning |
|-------|-------|-------|---------|
| 0 – 24 | 🟢 **Low** | Green | Migrate confidently, standard approach |
| 25 – 49 | 🟡 **Medium** | Yellow | Proceed with care, review carefully |
| 50 – 74 | 🟠 **High** | Orange | Requires senior review + phased approach |
| 75 – 100 | 🔴 **Critical** | Red | Do not migrate without architect sign-off |

---

### LLM Decision Gate (High / Critical Objects)

When `RiskScore ≥ 50`, the standard migration path is **blocked** and the LLM receives a structured prompt before any action is taken:

```
SYSTEM:
You are an SAP Clean Core migration architect. Analyze the following
object's risk profile and recommend the safest migration strategy.
Do NOT suggest direct replacement if any critical risk dimension is above 0.7.

USER:
Object: {objectName} ({objectType})
Classification: {level}
Risk Score: {riskScore}/100 — {riskLevel}

Risk Dimensions:
  Coupling (R1):            {R1 × 100}/100  ({callerCount} callers, {calleeCount} callees)
  Complexity (R2):          {R2 × 100}/100  ({loc} LOC, {findingCount} ATC findings)
  Integration Exposure (R3):{R3 × 100}/100  [{RFC/BAPI/IDoc flags}]
  Volatility (R4):          {R4 × 100}/100  ({changesLast12Months} transports in 12 months)
  Modification Type (R5):   {R5 × 100}/100  (type: {modType})
  Data Sensitivity (R6):    {R6 × 100}/100  (accesses: {sensitiveTableList})

ATC Findings Summary:
  {top 5 findings with check ID, priority, message}

Cloudification Suggestion (if any):
  {crvEntry.successor} — {crvEntry.note}

Recommend ONE of the following strategies with detailed justification:
  1. PHASED_WRAP    — Build wrapper first, migrate callers incrementally
  2. EXTENSION_POINT — Introduce a BAdI/enhancement point before migrating
  3. FREEZE_AND_MONITOR — Keep as-is, monitor, migrate in future release
  4. PARALLEL_RUN   — Build cloud-ready version alongside, A/B switch
  5. FULL_REWORK    — Redesign from scratch using released APIs
  6. ESCALATE       — Too risky to automate, requires manual architect session

Also provide:
  - Estimated additional effort (story points delta from standard estimate)
  - Top 3 specific risks the consultant must mitigate before starting
  - Suggested test strategy for regression validation
```

The LLM response is shown as a **"Risk Advisory"** card in the ObjectDetailPanel, pinned above the standard migration tasks and requiring explicit acknowledgment before proceeding.

---

## Technical Debt Formula (Hardcoded)

Derived once from the SAP "Clean Core with RISE with SAP" documentation and coded permanently into `src/debt/DebtFormula.ts`. No runtime PDF parsing — the formula constants are source code.

```typescript
// src/debt/DebtFormula.ts  — hardcoded constants from Clean Core documentation

const WEIGHTS = {
  atcFindings:       0.30,  // ATC findings are primary debt indicator
  linesOfCode:       0.20,  // raw complexity
  graphDepth:        0.20,  // dependency depth (migration cost multiplier)
  modificationType:  0.20,  // modification type risk (from PDF classification)
  objectAge:         0.10,  // unmaintained objects accumulate hidden debt
};

const MOD_TYPE_MULTIPLIERS: Record<ModificationType, number> = {
  CLASSICAL_MODIFICATION:  1.0,
  IMPLICIT_ENHANCEMENT:    0.80,
  EXPLICIT_ENHANCEMENT:    0.65,
  BADI_IMPLEMENTATION:     0.40,
  CUSTOM_DEVELOPMENT:      0.25,
  WRAPPER_PROXY:           0.10,
};

const LOC_SATURATION      = 2000;   // > 2000 LOC = max score on this dimension
const DEPTH_SATURATION    = 10;     // > 10 levels deep = max score
const AGE_SATURATION_DAYS = 1825;   // > 5 years old = max score

function computeDebtScore(object: SapObjectMetrics): number {
  const findingScore = object.atcFindings.reduce((sum, f) =>
    sum + (f.priority === 1 ? 3 : f.priority === 2 ? 1.5 : 0.5), 0
  );
  const normalizedFindings  = Math.min(1, findingScore / 30);
  const normalizedLoc       = Math.min(1, object.loc / LOC_SATURATION);
  const normalizedDepth     = Math.min(1, object.graphDepth / DEPTH_SATURATION);
  const modMultiplier       = MOD_TYPE_MULTIPLIERS[object.modType];
  const ageDays             = daysBetween(object.lastChangedDate, new Date());
  const normalizedAge       = Math.min(1, ageDays / AGE_SATURATION_DAYS);

  return Math.round((
    WEIGHTS.atcFindings      * normalizedFindings +
    WEIGHTS.linesOfCode      * normalizedLoc      +
    WEIGHTS.graphDepth       * normalizedDepth    +
    WEIGHTS.modificationType * modMultiplier      +
    WEIGHTS.objectAge        * normalizedAge
  ) * 100);
}

// Story point estimation (from PDF effort classification table)
const SP_BY_CLASSIFICATION: Record<'A'|'B'|'C'|'D', number> = {
  A: 1,    // Delete: trivial
  B: 3,    // Minor adapt: small
  C: 8,    // Replace/wrap: medium sprint
  D: 21,   // Full rework: large
};

function computeEffortSP(level: 'A'|'B'|'C'|'D', graphDepth: number): number {
  const base = SP_BY_CLASSIFICATION[level];
  const depMultiplier = 1 + Math.min(1, graphDepth / DEPTH_SATURATION);
  return Math.ceil(base * depMultiplier);
}
```

---

## CRV Auto-Update Strategy

Every time the extension activates, `CrvDatastore` checks if the local copy is stale (> 24 hours old) and silently refreshes in the background:

```typescript
// src/crv/CrvDatastore.ts

const CRV_ZIP_URL =
  'https://github.com/SAP/abap-atc-cr-cv-s4hc/archive/refs/heads/main.zip';
const CRV_LOCAL_DIR = path.join(workspaceRoot, '.corepilot', 'crv');
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

async function ensureUpToDate(): Promise<void> {
  const timestampFile = path.join(CRV_LOCAL_DIR, '.last-updated');
  const lastUpdated   = getTimestamp(timestampFile);
  const isStale       = (Date.now() - lastUpdated) > STALE_THRESHOLD_MS;

  if (isStale) {
    // Background download — does not block extension startup
    downloadAndExtractZip(CRV_ZIP_URL, CRV_LOCAL_DIR)
      .then(() => writeTimestamp(timestampFile))
      .catch(err => outputChannel.appendLine(`CRV update failed: ${err.message}`));
  }

  await buildIndex();  // always build from whatever is local
}
```

No `git` CLI dependency. Pure HTTP download + ZIP extraction using the Node.js built-in `zlib` + `yauzl` npm package.

The user's **target S/4HANA release** (set in settings) filters which release folder is loaded into the index:
```
.corepilot/crv/src/{targetRelease}/objectReleaseInfo.json
```
If the target release folder doesn't exist in the repo, falls back to `objectReleaseInfoLatest.json`.

---

## SAP AI Core — Credentials in Settings

All credentials entered once by each user in VS Code settings. Sensitive values (password, clientSecret) go to **VS Code SecretStorage** — they are never written to disk in plaintext.

**Settings exposed in `package.json`:**
```json
{
  "corepilot.sap.host":              "https://your-sap-host:port",
  "corepilot.sap.client":            "100",
  "corepilot.sap.username":          "ABAP_USER",
  "corepilot.sap.targetRelease":     "2023",
  "corepilot.aicore.tokenUrl":       "https://<subaccount>.authentication.eu10.hana.ondemand.com/oauth/token",
  "corepilot.aicore.clientId":       "sb-...",
  "corepilot.aicore.apiBase":        "https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com",
  "corepilot.aicore.deploymentId":   "d1234abcd",
  "corepilot.aicore.resourceGroup":  "default"
}
```

**Stored in SecretStorage (never in settings.json):**
- `corepilot.sap.password`
- `corepilot.aicore.clientSecret`

A **Settings Page** in the webview dashboard has a connection test button for both SAP (ADT ping) and SAP AI Core (health check).

---

## Phase-by-Phase Build Plan

---

### Phase 1 — Extension Scaffold & Settings UI

**Files**:
- `package.json` — manifest, commands, configuration schema
- `src/extension.ts` — activate, register commands, boot orchestrator
- `src/ui/sidebar/SidebarProvider.ts` — TreeDataProvider for Z\*/Y\* object tree
- `src/ui/webview/DashboardPanel.ts` — WebviewPanel host
- `webview-ui/src/views/SettingsPage.tsx` — connection config + test buttons

**Done when**: Extension loads, sidebar shows, settings page renders, SAP + AI Core connections can be tested.

---

### Phase 2 — ADT REST Client & Object Discovery

**Files**:
- `src/sap/AdtClient.ts`
- `src/sap/ObjectDiscovery.ts`

**ADT endpoints used:**

| Action | Endpoint |
|--------|----------|
| Discovery / CSRF | `GET /sap/bc/adt/discovery` |
| Object search | `GET /sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=Z*&objectType=PROG,CLAS,FUGR,...` |
| PROG metadata | `GET /sap/bc/adt/programs/programs/{name}` |
| CLAS metadata | `GET /sap/bc/adt/oo/classes/{name}` |
| FUGR metadata | `GET /sap/bc/adt/functions/groups/{name}` |
| Source code | `GET /sap/bc/adt/{type}/{name}/source/main` |
| Where-used | `GET /sap/bc/adt/repository/informationsystem/usageReferences?objectName={name}&objectType={type}` |
| Transport history | `GET /sap/bc/adt/vit/wb/object/workbench/{name}` |

**Done when**: All Z\*/Y\* objects enumerated and displayed in sidebar with metadata.

---

### Phase 3 — ATC Runner & A/B/C/D Classification

**Files**:
- `src/sap/AtcRunner.ts`
- `src/agents/AtcAgent.ts`

**ATC flow:**
```
POST /sap/bc/adt/atc/runs          → create run, get runId from Location header
GET  /sap/bc/adt/atc/runs/{runId}  → poll (every 3s) until status = "completed"
GET  /sap/bc/adt/atc/runs/{runId}/findings → fetch all findings (XML)
```

**Classification mapping (deterministic):**

| Level | Rule |
|-------|------|
| **A** | `findingCount = 0` AND `callerCount = 0` |
| **B** | All findings are priority 3 (info) OR only `CL_CI_TEST_DEPRECATED_*` |
| **C** | Has `CL_CI_TEST_CLOUDIFICATION` findings at priority 2 (warning) |
| **D** | Has any priority 1 (error) finding OR `CL_CI_TEST_CLOUDIFICATION` + callerCount > 10 |

Tie-breaker: if an object qualifies for both C and D → D wins.

**Done when**: ATC findings stored, A/B/C/D badges appear in sidebar and inventory view.

---

### Phase 4 — CRV Datastore

**Files**:
- `src/crv/CrvDatastore.ts`

**Done when**: CRV auto-downloads on startup, lookup by `(objectType, objectName)` returns successor + note, stale check + silent refresh working.

---

### Phase 5 — Technical Debt & Risk Score

**Files**:
- `src/debt/DebtFormula.ts` — hardcoded formula + constants
- `src/debt/RiskScorer.ts` — 6-dimensional risk score + LLM gate logic
- `src/agents/DebtAnalystAgent.ts`

**DebtAnalystAgent flow:**
1. For each object: determine `modType` deterministically from SAP metadata,
   ATC findings, ABAP source patterns and naming conventions. Store
   `{ modType, modTypeConfidence, modTypeSource, modTypeEvidence }`.
2. Call `DebtFormula.computeDebtScore(metrics)` → `debtScore`
3. Call `DebtFormula.computeEffortSP(level, graphDepth)` → `effortSP`
4. Call `RiskScorer.compute(object, graph, adtMetrics)` → `RiskResult`
5. If `riskScore ≥ 50`: call LLM with the structured risk advisory prompt → `riskAdvisory`
6. Store: `{ debtScore, effortSP, riskScore, riskLevel, riskDimensions, riskAdvisory? }`

**Done when**: Debt score bar + risk chip visible in inventory view. Risk advisory card shown for High/Critical objects.

---

### Phase 6 — Dependency Graph

**Files**:
- `src/graph/DependencyGraph.ts`
- `src/graph/GraphSerializer.ts`
- `webview-ui/src/views/DependencyGraphView.tsx`

**Graph construction:**
1. Where-used data from ADT → `CALLS` edges
2. Source code pattern match (via LLM) → `USES_TABLE`, `ENHANCES` edges
3. ATC cross-references → validate edges

**Visualization:**
- cytoscape.js canvas in webview
- Node color: A=grey, B=green, C=yellow, D=red
- Node size = debtScore (bigger = more debt)
- Edge thickness = CALLS (thick) vs INCLUDES (thin)
- Click node → ObjectDetailPanel slides in
- Hover node → highlight all transitive callers (impact path)
- Toolbar: filter by level, risk, package

**Done when**: Interactive graph renders, impact path highlighting works, cycles shown with dashed red edges.

---

### Phase 7 — Cloudification Agent

**Files**:
- `src/agents/CloudificationAgent.ts`

**Flow per C/D object:**
1. Extract non-released API references from ATC findings (`CL_CI_TEST_CLOUDIFICATION`)
2. For each: `CrvDatastore.lookup(type, name)`
3. If successor exists → surface directly, no LLM needed
4. If no successor → LLM generates suggestion + ABAP wrapper scaffold
5. Determine `migrationApproach`: DELETE / KEEP / WRAP / REPLACE / REWORK

**ABAP wrapper scaffold template** (LLM fills in):
```abap
" Wrapper: {objectName}_WRAPPER
" Replaces usage of: {nonReleasedRef}
" Successor: {crvSuccessor}
CLASS zcl_{objectName}_wrapper DEFINITION
  PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS: {method_name}
      IMPORTING ...
      RETURNING VALUE(result) TYPE ...
  PRIVATE SECTION.
ENDCLASS.

CLASS zcl_{objectName}_wrapper IMPLEMENTATION.
  METHOD {method_name}.
    " TODO: Implement using {crvSuccessor}
    " Original logic summary: {aiSummary}
  ENDMETHOD.
ENDCLASS.
```

**Done when**: Cloudification suggestion + wrapper scaffold visible in ObjectDetailPanel for every C/D object.

---

### Phase 8 — Migration Planner + Approval Workflow

**Files**:
- `src/agents/MigrationPlannerAgent.ts`
- `src/workflow/ApprovalManager.ts`
- `src/workflow/TaskQueue.ts`
- `webview-ui/src/views/MigrationPlanView.tsx`

**Task tree structure per object:**
```
Epic: [{level}] {objectName} — Risk: {riskLevel} — {effortSP} SP
│
├── [PENDING] Task 1: Review ATC Findings
│     • {N} findings | Top: "{finding.message}" ({finding.checkId})
│     • Action: Read findings → Approve understanding
│
├── [PENDING] Task 2: Confirm Classification
│     • Classified {level} because: {atcReasoning}
│     • Action: Approve | Override to different level
│
├── [PENDING] Task 3: Risk Advisory (High/Critical only)
│     • Risk Score: {riskScore}/100
│     • Recommended Strategy: {llmStrategy}
│     • Action: Acknowledge → Choose strategy → Proceed
│
├── [PENDING] Task 4a: Delete Object (A-level only)
│     • Zero callers confirmed
│     • Action: Confirm delete | Request re-scan
│
├── [PENDING] Task 4b: Apply Cloudification (C/D-level)
│     • Replace: {nonReleasedRef} → {successor}
│     • Code: {wrapperScaffold}
│     • Action: Approve scaffold | Edit in panel | Regenerate with AI
│
└── [PENDING] Task 5: Close & Transport
      • Action: Mark done | Note transport request number
```

**Approval state machine:**
```
PENDING ──► IN_REVIEW ──► APPROVED ──► (next task unlocks)
                      └──► REJECTED ──► (agent re-runs with feedback)
                      └──► EDITED ──► APPROVED
                      └──► DEFERRED ──► (moved to backlog)
```

State persisted to `.corepilot/approval-state.json` — fully resumable across VS Code sessions.

**Done when**: Full task tree renders per object, approve/reject/defer buttons functional, state persists on restart.

---

### Phase 9 — Export & Polish

**Files**:
- `src/export/ReportGenerator.ts`
- `webview-ui/src/views/AgentStreamView.tsx` (streaming polish)

**Export output** (`.corepilot/reports/migration-report.md`):
```markdown
# A-CorePilot Migration Report
Generated: {date} | System: {sapHost} | Objects analyzed: {count}

## Executive Summary
- A-level (Delete): {n} objects | Estimated: {sp} SP
- B-level (Keep/minor adapt): {n} objects | {sp} SP
- C-level (Replace/wrap): {n} objects | {sp} SP
- D-level (Full rework): {n} objects | {sp} SP
- Total effort: {totalSP} story points
- High/Critical risk objects: {n} (require architect review)

## Migration Order (Topological)
{ordered table of objects with level, risk, effort, strategy}

## Critical Path
{longest dependency chain — must be started first}

## Circular Dependencies (require manual intervention)
{list of detected cycles}

## Per-Object Detail
{for each object: findings, classification, debt score, risk score, strategy}
```

**Done when**: Report generates correctly, all UI animations smooth, dark theme consistent.

---

## Final File Structure

```
A-CorePilot/
├── package.json
├── tsconfig.json
├── webpack.config.js
│
├── src/
│   ├── extension.ts
│   │
│   ├── sap/
│   │   ├── AdtClient.ts
│   │   ├── ObjectDiscovery.ts
│   │   └── AtcRunner.ts
│   │
│   ├── agents/
│   │   ├── IAgent.ts
│   │   ├── ScannerAgent.ts
│   │   ├── AtcAgent.ts
│   │   ├── DebtAnalystAgent.ts
│   │   ├── CloudificationAgent.ts
│   │   └── MigrationPlannerAgent.ts
│   │
│   ├── orchestrator/
│   │   └── AgentOrchestrator.ts
│   │
│   ├── crv/
│   │   └── CrvDatastore.ts            # Auto-refresh ZIP download
│   │
│   ├── debt/
│   │   ├── DebtFormula.ts             # Hardcoded constants + computeDebtScore()
│   │   └── RiskScorer.ts              # 6-dimensional risk + LLM gate
│   │
│   ├── graph/
│   │   ├── DependencyGraph.ts
│   │   └── GraphSerializer.ts
│   │
│   ├── workflow/
│   │   ├── ApprovalManager.ts
│   │   └── TaskQueue.ts
│   │
│   ├── export/
│   │   └── ReportGenerator.ts
│   │
│   ├── services/
│   │   └── SapAiCoreService.ts        # OAuth + streaming completions
│   │
│   └── ui/
│       ├── sidebar/
│       │   └── SidebarProvider.ts
│       └── webview/
│           └── DashboardPanel.ts
│
├── webview-ui/
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── App.tsx
│       ├── views/
│       │   ├── ObjectInventory.tsx     # Table + badges
│       │   ├── DependencyGraphView.tsx # cytoscape.js
│       │   ├── MigrationPlanView.tsx   # Task board
│       │   ├── ObjectDetailPanel.tsx   # Slide-in detail
│       │   ├── AgentStreamView.tsx     # AI stream
│       │   └── SettingsPage.tsx
│       ├── components/
│       │   ├── RiskRadarChart.tsx      # 6-dimension radar
│       │   ├── DebtScoreBar.tsx
│       │   ├── ClassBadge.tsx          # A/B/C/D badge
│       │   └── RiskAdvisoryCard.tsx    # LLM advisory for High/Critical
│       └── styles/
│           └── index.css
│
└── .corepilot/                        # gitignored, per-workspace
    ├── crv/                           # auto-refreshed
    ├── migration-plan.json
    ├── dependency-graph.json
    ├── approval-state.json
    ├── scan-results.json
    ├── atc-findings.json
    └── reports/
        └── migration-report.md
```

---

## Delivery Roadmap

| Phase | Milestone | Output |
|-------|-----------|--------|
| **P1** | Scaffold | Extension loads, sidebar + settings page, connection test |
| **P2** | ADT Client | Z\*/Y\* objects in sidebar with metadata |
| **P3** | ATC + Classification | A/B/C/D badges, findings stored |
| **P4** | CRV | Auto-refresh ZIP, successor lookup working |
| **P5** | Debt + Risk | Debt score bars, risk chips, radar chart, risk advisory for High/Critical |
| **P6** | Graph | Interactive cytoscape graph, impact highlighting, cycle detection |
| **P7** | Cloudification | CRV-backed + AI wrapper scaffold per C/D object |
| **P8** | Plan + Approvals | Full Epic→Task tree, approval state machine, session resume |
| **P9** | Export + Polish | Markdown report, streaming UX, final UI polish |

---

## Verification Plan

### Unit Tests (Jest)
- `DebtFormula.computeDebtScore` — known inputs → expected score
- `DebtFormula.computeEffortSP` — each classification level
- `RiskScorer.compute` — each dimension independently, then combined
- `AtcAgent` — classification mapping for every priority + check ID combination
- `DependencyGraph` — topoSort, detectCycles, impactOf
- `CrvDatastore` — parse, lookup hit, lookup miss, stale detection

### Integration Tests
- `AdtClient` — mock HTTP server returning recorded ADT XML responses
- `SapAiCoreService` — mock OAuth token endpoint + chat completion

### Manual Acceptance Tests
- Connect to real SAP sandbox, scan a Z-package
- Confirm ATC findings match SAP ATC UI
- Verify risk score dimensions are plausible (RFC FM scores high on R₃)
- Walk through approval flow: A-level delete, C-level wrapper, D-level risk advisory
- Confirm graph topology matches known package dependencies
- Export report and validate all sections complete
