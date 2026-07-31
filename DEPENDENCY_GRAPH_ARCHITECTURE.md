# A-CorePilot Dependency Graph Architecture

This document explains what was added for the local dependency graph, why it was added, and how the graph works inside the VS Code extension.

## Goal

The dependency graph helps SAP consultants understand how custom ABAP objects depend on each other before migration.

It answers questions like:

- Which objects call this object?
- Which objects does this object depend on?
- What is the impact if this object changes?
- Are there circular dependencies?
- Which objects have higher migration risk because they sit deep in the dependency chain?

The graph is built locally inside the VS Code extension. It does not use HANA Cloud yet.

## Main Files Added Or Updated

### Backend Graph Files

- `src/graph/DependencyGraph.ts`
  - Builds the graph model.
  - Creates nodes and edges.
  - Calculates graph depth, caller count, callee count, cycles, and topological order.

- `src/graph/GraphSerializer.ts`
  - Builds a serialized graph from scanned objects.
  - Saves the graph to disk.
  - Loads the graph back from disk.

- `src/graph/GraphMarkdownReport.ts`
  - Generates a Markdown dependency graph section for the future migration report.
  - Includes graph metrics, critical path, migration order, circular dependencies, and ATC-validated edges.

### SAP Discovery Updates

- `src/sap/ObjectDiscovery.ts`
  - Added graph-related fields to each scanned object.
  - Extracts caller references from ADT where-used XML.
  - Extracts outgoing dependencies from ABAP source code patterns.

### Scan Flow Updates

- `src/agents/ScannerAgent.ts`
  - Builds the dependency graph after object discovery.
  - Uses graph depth for later debt calculations.
  - Rebuilds and saves the graph after debt analysis so the UI has final debt scores.
  - Saves the graph to `.corepilot/dependency-graph.json`.

### Webview Updates

- `webview-ui/src/views/DependencyGraphView.tsx`
  - Renders the interactive graph using Cytoscape.js.
  - Supports node click, hover impact highlighting, filters, and cycle display.

- `webview-ui/src/App.tsx`
  - Adds the new `Dependency Graph` tab.

- `webview-ui/src/styles/index.css`
  - Adds styling for the graph workspace, toolbar, filters, canvas, and detail panel.

- `webview-ui/package.json`
  - Adds the `cytoscape` dependency.

## Data Model

Each scanned object now has extra graph fields:

```ts
callers: DependencyReference[];
dependencies: ObjectDependency[];
calleeCount: number;
graphDepth: number;
```

### DependencyReference

Represents another SAP object, usually a caller found from ADT where-used.

```ts
interface DependencyReference {
  name: string;
  type: string;
  uri?: string;
  packageName?: string;
  description?: string;
}
```

### ObjectDependency

Represents an outgoing dependency found from source code or another source.

```ts
interface ObjectDependency extends DependencyReference {
  kind: DependencyKind;
  source: DependencySource;
  confidence: DependencyConfidence;
  rawText?: string;
}
```

Supported dependency kinds:

```ts
CALLS
INCLUDES
USES_TABLE
ENHANCES
```

Supported dependency sources:

```ts
ADT_WHERE_USED
SOURCE_PATTERN
ATC_FINDING
```

## How Dependencies Are Collected

There are two collection methods in the current implementation.

## 1. ADT Where-Used

For each scanned object, the extension calls the ADT where-used endpoint.

This tells us which objects directly call or reference the current object.

Example:

```text
ZREPORT_ORDER_UI calls ZCL_ORDER_SERVICE
```

The graph edge becomes:

```text
PROG::ZREPORT_ORDER_UI -> CLAS::ZCL_ORDER_SERVICE
```

The parser is implemented in:

```text
src/sap/ObjectDiscovery.ts
parseWhereUsedReferences()
```

Because SAP ADT XML can vary between systems, the parser is defensive. It looks for object-reference-like XML tags and tries to infer object name and type from attributes or ADT URIs.

### Where-Used Meaning

Where-used is the incoming dependency side of the graph.

For one object, it answers:

```text
Who uses this object?
```

Example target object:

```text
CLAS::ZCL_ORDER_SERVICE
```

Where-used may return:

```text
PROG::ZREPORT_ORDER_UI
CLAS::ZCL_ORDER_BATCH
CLAS::ZCL_INVOICE_SERVICE
```

The graph then creates incoming `CALLS` edges:

```text
PROG::ZREPORT_ORDER_UI -> CLAS::ZCL_ORDER_SERVICE
CLAS::ZCL_ORDER_BATCH -> CLAS::ZCL_ORDER_SERVICE
CLAS::ZCL_INVOICE_SERVICE -> CLAS::ZCL_ORDER_SERVICE
```

This is different from source-code dependency extraction.

```text
Where-used:
  other objects -> current object

Source dependency extraction:
  current object -> other objects
```

Both directions are needed to build the full dependency graph.

### Where-Used Implementation

The ADT request is implemented in:

```text
src/sap/AdtClient.ts
getWhereUsed()
```

The parser is implemented in:

```text
src/sap/ObjectDiscovery.ts
parseWhereUsedReferences()
parseCallerCount()
```

During object discovery:

```text
ObjectDiscovery.discoverAll()
  |
  v
AdtClient.getWhereUsed()
  |
  v
parseWhereUsedReferences()
  |
  v
obj.callers = [...]
obj.callerCount = callers.length
```

Later, the graph engine converts `obj.callers` into edges:

```text
caller -> current object
```

### Where-Used Current Status

Implemented now:

- Calls ADT where-used for supported object types.
- Parses caller object references from ADT XML.
- Falls back to caller count parsing if detailed caller references are not available.
- Stores caller references in `obj.callers`.
- Creates `CALLS` edges in the dependency graph.
- Uses caller count for impact analysis and risk/debt metrics.

Supported scan types for where-used:

```text
PROG
CLAS
FUGR
INTF
```

Subtypes like includes or generated program parts are skipped because they often do not have standalone ADT where-used support.

### Where-Used Next Improvements

Possible next improvements:

- Support more SAP object types if the ADT system returns stable metadata for them.
- Store the exact usage location if SAP returns line/object location data.
- Add a dedicated Where-Used section in the node detail panel.
- Add a `Refresh Where-Used` action for a single object.
- Add more test XML samples from real SAP systems.
- Distinguish different reference types if ADT exposes them, for example direct call, include, method reference, or table reference.

## 2. ABAP Source Pattern Matching And LLM Extraction

When source code is already fetched for LOC counting, the extension also checks the source for common ABAP dependency patterns.

Examples:

```abap
CALL FUNCTION 'Z_FM_CREATE_ORDER'
ZCL_ORDER_REPO=>SAVE( )
DATA(repo) = NEW zcl_order_repo( )
SUBMIT zreport_invoice
INCLUDE zinclude_shared
SELECT * FROM zorder_table
```

These become outgoing graph edges.

Example:

```text
CLAS::ZCL_ORDER_SERVICE -> CLAS::ZCL_ORDER_REPO
CLAS::ZCL_ORDER_SERVICE -> TABL::ZORDER_TABLE
```

The parser is implemented in:

```text
src/sap/ObjectDiscovery.ts
extractSourceDependencies()
```

This deterministic parser runs first. LLM extraction can then enrich it for complex or dynamic ABAP code.

For complex ABAP code, the extension can also call SAP AI Core and ask the LLM to extract dependencies as structured JSON.

The LLM is used only when the source looks complex or dynamic, for example:

- dynamic function calls
- dynamic method calls
- dynamic table names in Open SQL
- dynamic object creation
- macros
- large source files where regex found no dependencies

The AI method is implemented in:

```text
src/services/AiCoreClient.ts
extractDependenciesFromAbap()
```

LLM results are validated before being added to the graph. The LLM can create these edge kinds:

```text
CALLS
INCLUDES
USES_TABLE
ENHANCES
```

LLM-sourced edges use:

```text
source = LLM
```

If SAP AI Core is not configured, the scan continues normally with regex and ADT data only.

## 3. ATC Cross-Reference Validation

After ATC runs, the extension extracts object references from ATC finding messages.

Example ATC finding:

```text
Use of non-released API ZCL_OLD_API
```

The graph can add or validate this edge:

```text
Current object -> ZCL_OLD_API
```

The ATC extraction is implemented in:

```text
src/sap/ObjectDiscovery.ts
extractAtcDependencies()
```

ATC-sourced edges use:

```text
source = ATC_FINDING
confidence = high
```

If regex or LLM already found the same edge, ATC does not create a duplicate. Instead, the graph marks the existing edge as:

```text
validatedByAtc = true
```

The detail panel shows an `ATC` label beside validated edges.

## Graph Engine

The graph engine is implemented in:

```text
src/graph/DependencyGraph.ts
```

It converts scanned objects into:

```ts
nodes: DependencyGraphNode[]
edges: DependencyGraphEdge[]
cycles: DependencyGraphCycle[]
topologicalOrder: string[]
criticalPath: string[]
stats: DependencyGraphStats
```

## Nodes

Each node represents one SAP object.

Node IDs use this format:

```text
TYPE::OBJECT_NAME
```

Examples:

```text
CLAS::ZCL_ORDER_SERVICE
PROG::ZREPORT_ORDER_UI
TABL::ZORDER_TABLE
```

Each node contains:

- object name
- object type
- package
- classification A/B/C/D
- debt score
- risk score
- LOC
- caller count
- callee count
- graph depth
- whether it is external to the scanned object list

## Edges

Each edge represents a dependency.

The direction is:

```text
source object -> target object
```

Example:

```text
PROG::ZREPORT_ORDER_UI -> CLAS::ZCL_ORDER_SERVICE
```

The edge stores:

- source node
- target node
- dependency kind
- source of the dependency
- confidence level
- whether it is part of a cycle

## Metrics Calculated

### Caller Count

How many objects call the current object.

This is important for impact analysis. If many objects call one object, changing it is riskier.

### Callee Count

How many objects the current object depends on.

This helps estimate migration complexity.

### Graph Depth

How deep the object is in the dependency chain.

This is used by the technical debt calculation as a migration cost multiplier.

### Topological Order

The graph tries to calculate an order for migration.

Objects with fewer dependencies can usually be handled earlier.

If cycles exist, those nodes are still returned but cannot be perfectly ordered.

### Critical Path

The graph calculates the longest dependency chain it can find.

This is useful because long chains usually represent work that should be understood early in a migration.

The serialized graph stores it as:

```ts
criticalPath: string[]
```

### Cycle Detection

Cycles are circular dependencies.

Example:

```text
ZCL_A -> ZCL_B -> ZCL_A
```

These are detected by `detectCycles()` and shown in the UI as dashed red edges.

## Persistence

After the scan, the graph is saved here:

```text
.corepilot/dependency-graph.json
```

This file contains the complete graph:

```json
{
  "version": 1,
  "generatedAt": "...",
  "nodes": [],
  "edges": [],
  "cycles": [],
  "topologicalOrder": [],
  "criticalPath": [],
  "stats": {}
}
```

The dashboard can reload this file later without running a new scan.

If old scan results exist but no graph file exists yet, the extension tries to rebuild the graph from the saved scan results.

## Scan Flow

The full flow now works like this:

```text
Start Scan
  |
  v
ObjectDiscovery
  |
  |-- ADT where-used -> callers
  |-- source regex patterns -> dependencies
  |-- optional SAP AI Core LLM -> complex dependencies
  v
Build DependencyGraph
  |
  |-- calculate callerCount
  |-- calculate calleeCount
  |-- calculate graphDepth
  v
ATC Scan
  |
  |-- ATC findings -> validate or add graph edges
  v
Rebuild DependencyGraph with ATC evidence
  |
  v
CRV Enrichment
  |
  v
Debt Analysis
  |
  v
Rebuild DependencyGraph with final debt scores
  |
  v
Save:
  .corepilot/scan-results.json
  .corepilot/dependency-graph.json
```

## UI Architecture

The graph UI is implemented in:

```text
webview-ui/src/views/DependencyGraphView.tsx
```

It loads graph data through VS Code webview messages:

```text
DependencyGraphView -> loadDependencyGraph
DashboardPanel -> dependencyGraphLoaded
```

Then it renders the graph using Cytoscape.js.

## UI Behavior

### Node Colors

```text
A = gray
B = green
C = yellow
D = red
External = muted gray
```

### Node Size

Node size is based on `debtScore`.

Higher debt means a bigger node.

### Edge Style

```text
CALLS = thicker edge
INCLUDES = thinner edge
USES_TABLE = medium edge
ENHANCES = medium edge
Cycle edge = dashed red
```

### Click Node

Clicking a node opens a detail panel.

The detail panel shows:

- object name
- type
- package
- classification
- debt score
- risk score
- LOC
- callers
- dependencies
- graph depth
- incoming dependencies
- outgoing dependencies
- cycles involving that node

### Hover Node

Hovering a node highlights its transitive callers.

This shows the impact path:

```text
If I change this object, these callers may be affected.
```

### Filters

The graph has filters for:

- classification
- package
- dependency type
- object search

The UI also shows:

- critical path
- migration order
- ATC validation labels on validated edges

Clicking an item in the critical path or migration order focuses that node in the graph.

## Testing Done

The project was built successfully with:

```powershell
npm run compile
```

A local smoke test was also run against the graph engine using fake SAP objects.

The smoke test verified:

- node creation
- edge creation
- cycle detection
- graph depth calculation
- caller count calculation
- callee count calculation

Permanent graph tests were added in:

```text
src/test/graph/DependencyGraph.test.ts
```

Run them with:

```powershell
npm run test:graph
```

They verify:

- graph build and serialization
- ATC edge validation and confidence upgrade
- critical path output
- ABAP source dependency extraction
- ATC finding dependency extraction
- ADT where-used reference parsing

## Limitations

Current limitations:

- A real SAP scan is still needed to generate real graph data.
- Source dependency extraction starts with regex and uses LLM for complex code, but it is still not a full ABAP parser.
- HANA Cloud Graph is not used yet.
- ATC validation depends on ATC messages containing recognizable object references.
- The full Phase 9 report/export command does not exist yet, but a graph Markdown section generator is ready.

## Future Improvements

Possible next steps:

- Add more ABAP source patterns.
- Wire `GraphMarkdownReport.ts` into the final migration report once the report command exists.
- Add HANA Cloud Graph integration if the project needs server-side graph queries later.
