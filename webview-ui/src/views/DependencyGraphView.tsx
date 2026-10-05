import React, { useEffect, useMemo, useRef, useState } from 'react';
import cytoscape from 'cytoscape';
import { vscode } from '../vscodeApi';

type ClassLevel = 'A' | 'B' | 'C' | 'D';
type RiskLevel = 'Low' | 'Medium' | 'High' | 'Critical';
type EdgeKind = 'CALLS' | 'INCLUDES' | 'IMPLEMENTS' | 'BADI_IMPLEMENTATION' | 'USES_TABLE' | 'ENHANCES';
type EdgeSource = 'SAP_CROSSREF' | 'ADT_WHERE_USED' | 'SOURCE_PATTERN' | 'METADATA' | 'LLM' | 'ATC_FINDING';
type ClassFilter = 'all' | ClassLevel | 'external';

interface GraphNode {
  id: string;
  name: string;
  type: string;
  packageName: string;
  description: string;
  classification?: ClassLevel;
  debtScore?: number;
  effortSP?: number;
  riskScore?: number;
  riskLevel?: RiskLevel;
  loc: number;
  callerCount: number;
  calleeCount: number;
  impactCount?: number;
  graphDepth: number;
  external: boolean;
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  sourceType: EdgeSource;
  sourceTypes?: EdgeSource[];
  confidence: 'high' | 'medium' | 'low';
  label: string;
  rawText?: string;
  evidence?: string[];
  validatedByAtc?: boolean;
  verified?: boolean;
  verificationNote?: string;
  cycle: boolean;
}

interface GraphCycle {
  id: string;
  nodeIds: string[];
  edgeIds: string[];
}

interface DependencyGraphData {
  version: 3;
  generatedAt: string;
  historicalDemo?: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
  cycles: GraphCycle[];
  topologicalOrder: string[];
  criticalPath?: string[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    internalNodeCount: number;
    externalNodeCount: number;
    cycleCount: number;
  };
}

interface Props {
  onStartScan: () => void;
  isActive: boolean;
}

const demoNode = (
  id: string, name: string, type: string, packageName: string, description: string,
  classification: ClassLevel, loc: number, callerCount: number, calleeCount: number,
  impactCount: number, graphDepth: number, riskLevel: RiskLevel,
): GraphNode => ({
  id, name, type, packageName, description, classification,
  debtScore: riskLevel === 'Critical' ? 78 : riskLevel === 'High' ? 58 : riskLevel === 'Medium' ? 34 : 16,
  effortSP: riskLevel === 'Critical' ? 13 : riskLevel === 'High' ? 8 : riskLevel === 'Medium' ? 5 : 2,
  riskScore: riskLevel === 'Critical' ? 82 : riskLevel === 'High' ? 64 : riskLevel === 'Medium' ? 39 : 18,
  riskLevel, loc, callerCount, calleeCount, impactCount, graphDepth, external: false,
});

const demoEdge = (
  source: string, target: string, kind: EdgeKind, sourceType: EdgeSource = 'SOURCE_PATTERN',
  confidence: 'high' | 'medium' | 'low' = 'high', cycle = false,
): GraphEdge => ({
  id: `${source}->${target}`, source, target, kind, sourceType, confidence,
  label: kind === 'USES_TABLE' ? 'USES TABLE' : kind, evidence: ['Historical demonstration reference'],
  verified: true, cycle,
});

const DEMO_GRAPH_CATALOG: GraphNode[] = Array.from({ length: 82 }, (_, index) => {
  const number = String(index + 1).padStart(3, '0');
  const domains = [
    ['CORE', 'ZCORE_DEMO', 'Core order management'],
    ['SALES', 'ZSD_DEMO', 'Sales and distribution'],
    ['FIN', 'ZFI_DEMO', 'Finance and controlling'],
    ['INT', 'ZINT_DEMO', 'Integration services'],
    ['LOG', 'ZLOG_DEMO', 'Logistics operations'],
  ] as const;
  const [prefix, packageName, domainDescription] = domains[index % domains.length];
  const type = ['CLAS', 'PROG', 'TABL', 'INTF', 'FUGR'][index % 5];
  const namePrefix = type === 'CLAS' ? 'ZCL' : type === 'PROG' ? 'ZREPORT' : type === 'TABL' ? 'ZTABLE' : type === 'INTF' ? 'ZIF' : 'ZFG';
  const name = `${namePrefix}_${prefix}_${number}`;
  const loc = type === 'TABL' ? 0 : 140 + ((index * 67) % 980);
  const callerCount = 1 + ((index * 3) % 8);
  const calleeCount = type === 'TABL' || type === 'INTF' ? 0 : 1 + ((index * 5) % 6);
  const impactCount = callerCount + calleeCount;
  const classification: ClassLevel = impactCount >= 11 ? 'D' : impactCount >= 8 ? 'C' : impactCount >= 4 ? 'B' : 'A';
  const riskLevel: RiskLevel = impactCount >= 11 ? 'Critical' : impactCount >= 8 ? 'High' : impactCount >= 4 ? 'Medium' : 'Low';
  return demoNode(`${type}::${name}`, name, type, packageName, `${domainDescription} demonstration object ${number}`, classification, loc, callerCount, calleeCount, impactCount, 1 + (index % 5), riskLevel);
});

const DEMO_GRAPH_CATALOG_EDGES: GraphEdge[] = Array.from({ length: 82 }, (_, index) => {
  const node = DEMO_GRAPH_CATALOG[index];
  const previous = DEMO_GRAPH_CATALOG[(index + 82 - 1) % 82];
  const anchor = ['CLAS::ZCL_ORDER_SERVICE', 'CLAS::ZCL_PRICING_ENGINE', 'CLAS::ZCL_INVOICE_SERVICE', 'CLAS::ZAPI_ORDER_OUTBOUND', 'CLAS::ZCL_DELIVERY_TRACKER'][index % 5];
  const kind: EdgeKind = node.type === 'TABL' ? 'USES_TABLE' : index % 9 === 0 ? 'ENHANCES' : index % 7 === 0 ? 'IMPLEMENTS' : 'CALLS';
  return demoEdge(node.id, index % 3 === 0 ? anchor : previous.id, kind, index % 4 === 0 ? 'ADT_WHERE_USED' : 'SOURCE_PATTERN', index % 6 === 0 ? 'medium' : 'high');
});

const DEMO_CROSS_DOMAIN_EDGES: GraphEdge[] = Array.from({ length: 36 }, (_, index) => {
  const source = DEMO_GRAPH_CATALOG[index * 2];
  const target = DEMO_GRAPH_CATALOG[(index * 2 + 17) % 82];
  const kind: EdgeKind = index % 4 === 0 ? 'USES_TABLE' : index % 5 === 0 ? 'INCLUDES' : 'CALLS';
  return demoEdge(source.id, target.id, kind, 'SOURCE_PATTERN', index % 8 === 0 ? 'medium' : 'high', index === 8 || index === 24);
});

const DEMO_GRAPH: DependencyGraphData = {
  version: 3,
  generatedAt: '2025-07-15T00:00:00.000Z',
  historicalDemo: true,
  nodes: [
    demoNode('CLAS::ZCL_ORDER_SERVICE', 'ZCL_ORDER_SERVICE', 'CLAS', 'ZCORE_DEMO', 'Order processing service', 'B', 428, 5, 4, 9, 1, 'Medium'),
    demoNode('PROG::ZREPORT_ORDER_UI', 'ZREPORT_ORDER_UI', 'PROG', 'ZCORE_DEMO', 'Order overview report', 'C', 286, 0, 5, 6, 0, 'High'),
    demoNode('CLAS::ZCL_INVOICE_SERVICE', 'ZCL_INVOICE_SERVICE', 'CLAS', 'ZFI_DEMO', 'Invoice integration service', 'C', 512, 4, 3, 7, 2, 'High'),
    demoNode('CLAS::ZCL_ORDER_BATCH', 'ZCL_ORDER_BATCH', 'CLAS', 'ZCORE_DEMO', 'Background order processing', 'B', 364, 2, 4, 6, 1, 'Medium'),
    demoNode('TABL::ZORDER_STATUS', 'ZORDER_STATUS', 'TABL', 'ZCORE_DEMO', 'Order status persistence', 'A', 0, 4, 0, 5, 3, 'Low'),
    demoNode('CLAS::ZCL_CUSTOMER_SERVICE', 'ZCL_CUSTOMER_SERVICE', 'CLAS', 'ZSD_DEMO', 'Customer master facade', 'C', 617, 3, 4, 8, 1, 'High'),
    demoNode('CLAS::ZCL_PRICING_ENGINE', 'ZCL_PRICING_ENGINE', 'CLAS', 'ZSD_DEMO', 'Sales pricing calculation', 'D', 742, 6, 3, 10, 2, 'Critical'),
    demoNode('PROG::ZREPORT_SALES_ANALYSIS', 'ZREPORT_SALES_ANALYSIS', 'PROG', 'ZSD_DEMO', 'Sales analytics report', 'C', 934, 0, 6, 8, 0, 'High'),
    demoNode('TABL::ZSALES_ORDER', 'ZSALES_ORDER', 'TABL', 'ZSD_DEMO', 'Sales order persistence', 'B', 0, 5, 0, 7, 3, 'Medium'),
    demoNode('INTF::ZIF_PRICING_PROVIDER', 'ZIF_PRICING_PROVIDER', 'INTF', 'ZSD_DEMO', 'Pricing provider contract', 'A', 118, 2, 0, 4, 3, 'Low'),
    demoNode('CLAS::ZCL_PAYMENT_ADAPTER', 'ZCL_PAYMENT_ADAPTER', 'CLAS', 'ZFI_DEMO', 'Payment gateway adapter', 'C', 388, 3, 3, 6, 2, 'High'),
    demoNode('PROG::ZFI_POSTING_JOB', 'ZFI_POSTING_JOB', 'PROG', 'ZFI_DEMO', 'Finance posting background job', 'B', 476, 1, 4, 5, 1, 'Medium'),
    demoNode('TABL::ZFI_DOCUMENT', 'ZFI_DOCUMENT', 'TABL', 'ZFI_DEMO', 'Finance document persistence', 'B', 0, 4, 0, 6, 3, 'Medium'),
    demoNode('CLAS::ZCL_DELIVERY_TRACKER', 'ZCL_DELIVERY_TRACKER', 'CLAS', 'ZINT_DEMO', 'Delivery status tracking', 'C', 559, 3, 3, 6, 2, 'High'),
    demoNode('CLAS::ZAPI_ORDER_OUTBOUND', 'ZAPI_ORDER_OUTBOUND', 'CLAS', 'ZINT_DEMO', 'Outbound order API', 'D', 831, 2, 5, 8, 1, 'Critical'),
    demoNode('CLAS::ZCL_LEGACY_WRAPPER', 'ZCL_LEGACY_WRAPPER', 'CLAS', 'ZINT_DEMO', 'Legacy integration wrapper', 'D', 1068, 2, 3, 7, 2, 'Critical'),
    demoNode('CLAS::ZBADI_ORDER_ENRICH', 'ZBADI_ORDER_ENRICH', 'CLAS', 'ZCORE_DEMO', 'Order enhancement implementation', 'B', 244, 1, 2, 3, 2, 'Medium'),
    demoNode('TABL::ZINVOICE_ARCHIVE', 'ZINVOICE_ARCHIVE', 'TABL', 'ZFI_DEMO', 'Archived invoice records', 'A', 0, 2, 0, 3, 3, 'Low'),
    ...DEMO_GRAPH_CATALOG,
  ],
  edges: [
    demoEdge('PROG::ZREPORT_ORDER_UI', 'CLAS::ZCL_ORDER_SERVICE', 'CALLS', 'ADT_WHERE_USED'),
    demoEdge('CLAS::ZCL_ORDER_BATCH', 'CLAS::ZCL_ORDER_SERVICE', 'CALLS'),
    demoEdge('CLAS::ZCL_ORDER_SERVICE', 'CLAS::ZCL_INVOICE_SERVICE', 'CALLS', 'SOURCE_PATTERN', 'medium'),
    demoEdge('PROG::ZREPORT_ORDER_UI', 'TABL::ZORDER_STATUS', 'USES_TABLE'),
    demoEdge('CLAS::ZCL_ORDER_BATCH', 'TABL::ZORDER_STATUS', 'USES_TABLE'),
    demoEdge('PROG::ZREPORT_ORDER_UI', 'CLAS::ZCL_CUSTOMER_SERVICE', 'CALLS'),
    demoEdge('CLAS::ZCL_CUSTOMER_SERVICE', 'CLAS::ZCL_PRICING_ENGINE', 'CALLS'),
    demoEdge('CLAS::ZCL_PRICING_ENGINE', 'INTF::ZIF_PRICING_PROVIDER', 'IMPLEMENTS'),
    demoEdge('PROG::ZREPORT_SALES_ANALYSIS', 'CLAS::ZCL_PRICING_ENGINE', 'CALLS', 'ADT_WHERE_USED'),
    demoEdge('PROG::ZREPORT_SALES_ANALYSIS', 'TABL::ZSALES_ORDER', 'USES_TABLE'),
    demoEdge('CLAS::ZCL_PRICING_ENGINE', 'TABL::ZSALES_ORDER', 'USES_TABLE'),
    demoEdge('CLAS::ZCL_INVOICE_SERVICE', 'CLAS::ZCL_PAYMENT_ADAPTER', 'CALLS'),
    demoEdge('PROG::ZFI_POSTING_JOB', 'CLAS::ZCL_INVOICE_SERVICE', 'CALLS'),
    demoEdge('PROG::ZFI_POSTING_JOB', 'TABL::ZFI_DOCUMENT', 'USES_TABLE'),
    demoEdge('CLAS::ZCL_PAYMENT_ADAPTER', 'TABL::ZFI_DOCUMENT', 'USES_TABLE'),
    demoEdge('CLAS::ZCL_INVOICE_SERVICE', 'TABL::ZINVOICE_ARCHIVE', 'USES_TABLE'),
    demoEdge('CLAS::ZAPI_ORDER_OUTBOUND', 'CLAS::ZCL_ORDER_SERVICE', 'CALLS'),
    demoEdge('CLAS::ZAPI_ORDER_OUTBOUND', 'CLAS::ZCL_DELIVERY_TRACKER', 'CALLS'),
    demoEdge('CLAS::ZCL_DELIVERY_TRACKER', 'CLAS::ZCL_LEGACY_WRAPPER', 'CALLS', 'SOURCE_PATTERN', 'medium'),
    demoEdge('CLAS::ZCL_LEGACY_WRAPPER', 'CLAS::ZAPI_ORDER_OUTBOUND', 'CALLS', 'SOURCE_PATTERN', 'low', true),
    demoEdge('CLAS::ZBADI_ORDER_ENRICH', 'CLAS::ZCL_ORDER_SERVICE', 'ENHANCES'),
    demoEdge('CLAS::ZBADI_ORDER_ENRICH', 'TABL::ZORDER_STATUS', 'USES_TABLE'),
    demoEdge('CLAS::ZCL_CUSTOMER_SERVICE', 'TABL::ZSALES_ORDER', 'USES_TABLE'),
    demoEdge('CLAS::ZCL_ORDER_SERVICE', 'CLAS::ZCL_DELIVERY_TRACKER', 'CALLS', 'SOURCE_PATTERN', 'medium'),
    demoEdge('CLAS::ZCL_DELIVERY_TRACKER', 'TABL::ZORDER_STATUS', 'USES_TABLE'),
    ...DEMO_GRAPH_CATALOG_EDGES,
    ...DEMO_CROSS_DOMAIN_EDGES,
  ],
  cycles: [{ id: 'cycle-1', nodeIds: ['CLAS::ZAPI_ORDER_OUTBOUND', 'CLAS::ZCL_DELIVERY_TRACKER', 'CLAS::ZCL_LEGACY_WRAPPER'], edgeIds: ['CLAS::ZAPI_ORDER_OUTBOUND->CLAS::ZCL_DELIVERY_TRACKER', 'CLAS::ZCL_DELIVERY_TRACKER->CLAS::ZCL_LEGACY_WRAPPER', 'CLAS::ZCL_LEGACY_WRAPPER->CLAS::ZAPI_ORDER_OUTBOUND'] }],
  topologicalOrder: ['PROG::ZREPORT_ORDER_UI', 'PROG::ZREPORT_SALES_ANALYSIS', 'PROG::ZFI_POSTING_JOB', 'CLAS::ZCL_CUSTOMER_SERVICE', 'CLAS::ZCL_ORDER_BATCH', 'CLAS::ZCL_ORDER_SERVICE', 'CLAS::ZCL_PRICING_ENGINE', 'CLAS::ZCL_INVOICE_SERVICE', 'CLAS::ZCL_PAYMENT_ADAPTER', 'CLAS::ZCL_DELIVERY_TRACKER', 'TABL::ZORDER_STATUS', 'TABL::ZSALES_ORDER', 'TABL::ZFI_DOCUMENT', ...DEMO_GRAPH_CATALOG.map(node => node.id)],
  criticalPath: ['PROG::ZREPORT_SALES_ANALYSIS', 'CLAS::ZCL_PRICING_ENGINE', 'INTF::ZIF_PRICING_PROVIDER'],
  stats: { nodeCount: 100, edgeCount: 143, internalNodeCount: 100, externalNodeCount: 0, cycleCount: 1 },
};

const CLASS_COLORS: Record<ClassLevel, string> = {
  A: '#8c8c8c',
  B: '#52c41a',
  C: '#f5c542',
  D: '#ff5f57',
};

const KIND_COLORS: Record<EdgeKind, string> = {
  CALLS: '#4da3ff',
  INCLUDES: '#a6a6a6',
  IMPLEMENTS: '#7bdcb5',
  BADI_IMPLEMENTATION: '#ff9f43',
  USES_TABLE: '#16b6a5',
  ENHANCES: '#d783ff',
};

const INITIAL_KIND_FILTER: Record<EdgeKind, boolean> = {
  CALLS: true,
  INCLUDES: true,
  IMPLEMENTS: true,
  BADI_IMPLEMENTATION: true,
  USES_TABLE: true,
  ENHANCES: true,
};

export default function DependencyGraphView({ onStartScan, isActive }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const selectedNodeRef = useRef<string | null>(null);

  const [graph, setGraph] = useState<DependencyGraphData | null>(null);
  const [classFilter, setClassFilter] = useState<ClassFilter>('all');
  const [packageFilter, setPackageFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<Record<EdgeKind, boolean>>(INITIAL_KIND_FILTER);
  const [showCandidates, setShowCandidates] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [missingGraph, setMissingGraph] = useState(false);
  const [partialPhase, setPartialPhase] = useState<string | null>(null);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'scanComplete' && msg.dependencyGraph) {
        setGraph(msg.dependencyGraph);
        setMissingGraph(false);
        setPartialPhase(msg.scanStatus === 'partial' ? (msg.scanPhase ?? 'unknown') : null);
      }
      if (msg.type === 'dependencyGraphLoaded' && msg.dependencyGraph) {
        setGraph(msg.dependencyGraph);
        setMissingGraph(false);
        setPartialPhase(msg.scanStatus === 'partial' ? (msg.scanPhase ?? 'unknown') : null);
      }
      if (msg.type === 'noDependencyGraph' || msg.type === 'noScanResults') {
        setGraph(DEMO_GRAPH);
        setMissingGraph(false);
      }
    };

    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'loadDependencyGraph' });
    return () => window.removeEventListener('message', handler);
  }, []);

  const packages = useMemo(() => {
    if (!graph) return [];
    return Array.from(new Set(
      graph.nodes
        .filter(node => !node.external && node.packageName)
        .map(node => node.packageName)
    )).sort();
  }, [graph]);

  const nodeLookup = useMemo(() => {
    return new Map((graph?.nodes ?? []).map(node => [node.id, node]));
  }, [graph]);

  const visibleNodes = useMemo(() => {
    if (!graph) return [];

    const verifiedNodeIds = new Set(
      graph.edges
        .filter(edge => edge.verified)
        .flatMap(edge => [edge.source, edge.target])
    );

    return graph.nodes.filter(node => {
      const evidenceOk = showCandidates || !node.external || verifiedNodeIds.has(node.id);
      const classOk =
        classFilter === 'all' ||
        (classFilter === 'external' ? node.external : node.classification === classFilter);
      const packageOk = packageFilter === 'all' || node.packageName === packageFilter;
      const query = searchQuery.trim().toLowerCase();
      const searchOk = !query ||
        node.name.toLowerCase().includes(query) ||
        node.type.toLowerCase().includes(query) ||
        node.packageName.toLowerCase().includes(query) ||
        node.description.toLowerCase().includes(query);
      return evidenceOk && classOk && packageOk && searchOk;
    });
  }, [graph, classFilter, packageFilter, searchQuery, showCandidates]);

  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map(node => node.id)), [visibleNodes]);

  const visibleEdges = useMemo(() => {
    if (!graph) return [];
    return graph.edges.filter(edge =>
      (showCandidates || edge.verified) &&
      kindFilter[edge.kind] &&
      visibleNodeIds.has(edge.source) &&
      visibleNodeIds.has(edge.target)
    );
  }, [graph, kindFilter, visibleNodeIds, showCandidates]);

  const selectedNode = useMemo(
    () => graph?.nodes.find(node => node.id === selectedNodeId) ?? null,
    [graph, selectedNodeId]
  );

  const incomingEdges = useMemo(
    () => graph?.edges.filter(edge => edge.target === selectedNodeId && (showCandidates || edge.verified)) ?? [],
    [graph, selectedNodeId, showCandidates]
  );

  const outgoingEdges = useMemo(
    () => graph?.edges.filter(edge => edge.source === selectedNodeId && (showCandidates || edge.verified)) ?? [],
    [graph, selectedNodeId, showCandidates]
  );

  useEffect(() => {
    selectedNodeRef.current = selectedNodeId;
    const cy = cyRef.current;
    if (!cy) return;

    cy.nodes().removeClass('selected');
    if (selectedNodeId) {
      cy.getElementById(selectedNodeId).addClass('selected');
    }
  }, [selectedNodeId]);

  useEffect(() => {
    if (selectedNodeId && !visibleNodeIds.has(selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [selectedNodeId, visibleNodeIds]);

  useEffect(() => {
    if (!containerRef.current || !graph || !isActive) return;

    cyRef.current?.destroy();
    const elements = buildElements(visibleNodes, visibleEdges);
    const cy = cytoscape({
      container: containerRef.current,
      elements,
      layout: {
        name: elements.length <= 2 ? 'grid' : 'cose',
        animate: false,
        fit: true,
        padding: 42,
        idealEdgeLength: 110,
        nodeRepulsion: 6500,
      } as cytoscape.LayoutOptions,
      style: buildCytoscapeStyle(),
      wheelSensitivity: 0.18,
      minZoom: 0.18,
      maxZoom: 2.5,
    });

    cy.on('tap', 'node', event => {
      setSelectedNodeId(event.target.id());
    });

    cy.on('tap', event => {
      if (event.target === cy) {
        setSelectedNodeId(null);
      }
    });

    cy.on('mouseover', 'node', event => {
      applyImpactHighlight(cy, graph, event.target.id());
    });

    cy.on('mouseout', 'node', () => {
      clearImpactHighlight(cy, selectedNodeRef.current);
    });

    cyRef.current = cy;
    return () => {
      cy.destroy();
      if (cyRef.current === cy) {
        cyRef.current = null;
      }
    };
  }, [graph, visibleNodes, visibleEdges, isActive]);

  useEffect(() => {
    if (!isActive) return;
    // The graph can receive scan results while its tab is hidden. Wait for the
    // browser to lay out the visible container before recalculating Cytoscape.
    const frame = window.requestAnimationFrame(() => {
      cyRef.current?.resize();
      cyRef.current?.fit(undefined, 36);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isActive, graph]);

  const fitGraph = () => {
    cyRef.current?.fit(undefined, 36);
  };

  const runLayout = () => {
    cyRef.current?.layout({
      name: 'cose',
      animate: true,
      animationDuration: 350,
      fit: true,
      padding: 42,
      idealEdgeLength: 110,
      nodeRepulsion: 6500,
    } as cytoscape.LayoutOptions).run();
  };

  const toggleKind = (kind: EdgeKind) => {
    setKindFilter(current => ({ ...current, [kind]: !current[kind] }));
  };

  const focusNode = (nodeId: string) => {
    setSearchQuery('');
    setClassFilter('all');
    setPackageFilter('all');
    setSelectedNodeId(nodeId);

    window.setTimeout(() => {
      const cy = cyRef.current;
      if (!cy) return;
      const node = cy.getElementById(nodeId);
      if (node.length > 0) {
        cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 0.85) }, { duration: 250 });
      }
    }, 80);
  };

  if (!graph) {
    return (
      <div className="graph-root">
        <div className="graph-empty">
          <h2>{missingGraph ? 'No dependency graph yet' : 'Loading graph'}</h2>
          <p>Run a scan to generate the dependency graph from ADT where-used data and source references.</p>
          <button className="btn btn-primary" onClick={onStartScan}>Start Scan</button>
        </div>
      </div>
    );
  }

  return (
    <div className="graph-root">
      <div className="graph-toolbar">
        <div className="graph-toolbar-left">
          <span className="graph-count">
            {visibleNodes.length} nodes / {visibleEdges.length} edges
          </span>
          <input
            className="graph-search"
            type="text"
            placeholder="Search object"
            value={searchQuery}
            onChange={event => setSearchQuery(event.target.value)}
          />
          <select className="graph-select" value={classFilter} onChange={event => setClassFilter(event.target.value as ClassFilter)}>
            <option value="all">All classes</option>
            <option value="A">Class A</option>
            <option value="B">Class B</option>
            <option value="C">Class C</option>
            <option value="D">Class D</option>
            <option value="external">External</option>
          </select>
          <select className="graph-select" value={packageFilter} onChange={event => setPackageFilter(event.target.value)}>
            <option value="all">All packages</option>
            {packages.map(pkg => <option key={pkg} value={pkg}>{pkg}</option>)}
          </select>
        </div>

        <div className="graph-toolbar-right">
          <label className="graph-toggle" title="Show heuristic and unresolved relationships that do not affect production metrics">
            <input
              type="checkbox"
              checked={showCandidates}
              onChange={() => setShowCandidates(value => !value)}
            />
            <span>Candidate edges</span>
          </label>
          {Object.keys(INITIAL_KIND_FILTER).map(kind => (
            <label className="graph-toggle" key={kind}>
              <input
                type="checkbox"
                checked={kindFilter[kind as EdgeKind]}
                onChange={() => toggleKind(kind as EdgeKind)}
              />
              <span>{kindLabel(kind as EdgeKind)}</span>
            </label>
          ))}
          <button className="btn btn-secondary" onClick={fitGraph}>Fit</button>
          <button className="btn btn-secondary" onClick={runLayout}>Layout</button>
        </div>
      </div>

      <div className="graph-summary-strip">
        {graph.historicalDemo && <span>Historical demo</span>}
        {partialPhase && <span title="The previous scan stopped before completion">Partial scan: {partialPhase}</span>}
        <span>Internal {graph.stats.internalNodeCount}</span>
        <span>SAP verified {graph.edges.filter(edge => edge.verified).length}</span>
        <span>Candidates {graph.edges.filter(edge => !edge.verified).length}</span>
        <span>External {graph.stats.externalNodeCount}</span>
        <span>Cycles {graph.stats.cycleCount}</span>
        <span>Generated {relativeDate(graph.generatedAt)}</span>
      </div>

      <GraphAnalysisStrip
        criticalPath={graph.criticalPath ?? []}
        migrationOrder={graph.topologicalOrder ?? []}
        lookup={nodeLookup}
        onFocusNode={focusNode}
      />

      <div className={`graph-workspace ${selectedNode ? 'graph-workspace-with-detail' : ''}`}>
        <div className="graph-canvas" ref={containerRef} />
        {selectedNode && (
          <NodeDetail
            node={selectedNode}
            graph={graph}
            incomingEdges={incomingEdges}
            outgoingEdges={outgoingEdges}
            onClose={() => setSelectedNodeId(null)}
          />
        )}
      </div>
    </div>
  );
}

function GraphAnalysisStrip({
  criticalPath,
  migrationOrder,
  lookup,
  onFocusNode,
}: {
  criticalPath: string[];
  migrationOrder: string[];
  lookup: Map<string, GraphNode>;
  onFocusNode: (nodeId: string) => void;
}) {
  return (
    <div className="graph-analysis-strip">
      <GraphPathRow
        title="Critical Path"
        nodeIds={criticalPath}
        lookup={lookup}
        emptyText="No path"
        onFocusNode={onFocusNode}
      />
      <GraphPathRow
        title="Migration Order"
        nodeIds={migrationOrder.filter(id => !lookup.get(id)?.external)}
        lookup={lookup}
        emptyText="No order"
        onFocusNode={onFocusNode}
      />
    </div>
  );
}

function GraphPathRow({
  title,
  nodeIds,
  lookup,
  emptyText,
  onFocusNode,
}: {
  title: string;
  nodeIds: string[];
  lookup: Map<string, GraphNode>;
  emptyText: string;
  onFocusNode: (nodeId: string) => void;
}) {
  const visible = nodeIds.slice(0, 8);

  return (
    <div className="graph-path-row">
      <span className="graph-path-title">{title}</span>
      <div className="graph-path-items">
        {visible.length === 0 ? (
          <span className="graph-path-empty">{emptyText}</span>
        ) : (
          visible.map((nodeId, index) => {
            const node = lookup.get(nodeId);
            return (
              <React.Fragment key={`${title}-${nodeId}`}>
                {index > 0 && <span className="graph-path-arrow">-&gt;</span>}
                <button className="graph-path-chip" onClick={() => onFocusNode(nodeId)}>
                  {node?.name ?? nodeId}
                </button>
              </React.Fragment>
            );
          })
        )}
        {nodeIds.length > visible.length && (
          <span className="graph-path-more">+{nodeIds.length - visible.length}</span>
        )}
      </div>
    </div>
  );
}

function NodeDetail({
  node,
  graph,
  incomingEdges,
  outgoingEdges,
  onClose,
}: {
  node: GraphNode;
  graph: DependencyGraphData;
  incomingEdges: GraphEdge[];
  outgoingEdges: GraphEdge[];
  onClose: () => void;
}) {
  const lookup = useMemo(() => new Map(graph.nodes.map(item => [item.id, item])), [graph.nodes]);
  const cycles = graph.cycles.filter(cycle => cycle.nodeIds.includes(node.id));

  return (
    <aside className="graph-detail-panel">
      <div className="graph-detail-header">
        <div>
          <div className="graph-detail-title">{node.name}</div>
          <div className="graph-detail-subtitle">{node.type}{node.packageName ? ` / ${node.packageName}` : ''}</div>
        </div>
        <button className="graph-close-btn" onClick={onClose} aria-label="Close detail">x</button>
      </div>

      {node.description && <p className="graph-detail-description">{node.description}</p>}

      <div className="graph-metrics">
        <Metric label="Class" value={node.external ? 'External' : node.classification ?? '-'} />
        <Metric label="Debt" value={displayNumber(node.debtScore)} />
        <Metric label="Risk" value={node.riskScore === undefined ? '-' : `${node.riskScore} ${node.riskLevel ?? ''}`.trim()} />
        <Metric label="LOC" value={displayNumber(node.loc)} />
        <Metric label="Where Used" value={displayNumber(node.callerCount)} />
        <Metric label="Dependencies" value={displayNumber(node.calleeCount)} />
        <Metric label="Total Impact" value={displayNumber(node.impactCount ?? impactPath(graph, node.id).nodeIds.length)} />
        <Metric label="Depth" value={displayNumber(node.graphDepth)} />
        <Metric label="Effort" value={node.effortSP === undefined ? '-' : `${node.effortSP} SP`} />
      </div>

      <EdgeList title="Incoming" edges={incomingEdges} lookup={lookup} direction="source" />
      <EdgeList title="Outgoing" edges={outgoingEdges} lookup={lookup} direction="target" />

      {cycles.length > 0 && (
        <div className="graph-detail-section">
          <div className="graph-detail-section-title">Cycles</div>
          {cycles.map(cycle => (
            <div className="graph-cycle-row" key={cycle.id}>
              {cycle.nodeIds.map(id => lookup.get(id)?.name ?? id).join(' -> ')}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="graph-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function EdgeList({
  title,
  edges,
  lookup,
  direction,
}: {
  title: string;
  edges: GraphEdge[];
  lookup: Map<string, GraphNode>;
  direction: 'source' | 'target';
}) {
  return (
    <div className="graph-detail-section">
      <div className="graph-detail-section-title">{title}</div>
      {edges.length === 0 ? (
        <div className="graph-edge-empty">None</div>
      ) : (
        edges.slice(0, 8).map(edge => {
          const peer = lookup.get(edge[direction]);
          return (
            <div className="graph-edge-row" key={edge.id}>
              <span className="graph-edge-kind">{kindLabel(edge.kind)}</span>
              <span className="graph-edge-peer">{peer?.name ?? edge[direction]}</span>
              <span
                className={edge.verified ? 'graph-edge-proof' : 'graph-edge-candidate'}
                title={edge.verificationNote}
              >
                {edge.verified ? 'VERIFIED' : 'CANDIDATE'}
              </span>
              {edge.validatedByAtc && <span className="graph-edge-proof">ATC</span>}
            </div>
          );
        })
      )}
      {edges.length > 8 && <div className="graph-edge-more">+{edges.length - 8} more</div>}
    </div>
  );
}

function buildElements(nodes: GraphNode[], edges: GraphEdge[]): cytoscape.ElementDefinition[] {
  return [
    ...nodes.map(node => ({
      data: {
        id: node.id,
        label: node.name,
        color: nodeColor(node),
        size: nodeSize(node),
      },
      classes: [
        node.external ? 'external' : '',
        node.classification ? `class-${node.classification}` : 'class-unknown',
      ].filter(Boolean).join(' '),
    })),
    ...edges.map(edge => ({
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: kindLabel(edge.kind),
        color: KIND_COLORS[edge.kind],
        width: edgeWidth(edge.kind),
      },
      classes: [edge.cycle ? 'cycle-edge' : '', edge.verified ? '' : 'candidate-edge'].filter(Boolean).join(' '),
    })),
  ];
}

function buildCytoscapeStyle(): cytoscape.StylesheetJson {
  const foreground = cssVar('--vscode-foreground', '#d4d4d4');
  const muted = cssVar('--vscode-descriptionForeground', '#8a8a8a');
  const border = cssVar('--vscode-panel-border', '#3c3c3c');
  const focus = cssVar('--vscode-focusBorder', '#0078d4');

  const stylesheet = [
    {
      selector: 'node',
      style: {
        'background-color': 'data(color)',
        'border-color': border,
        'border-width': 1,
        'color': foreground,
        'font-family': 'sans-serif',
        'font-size': '10px',
        'height': 'data(size)',
        'label': 'data(label)',
        'overlay-opacity': 0,
        'text-halign': 'center',
        'text-margin-y': '7px',
        'text-max-width': 92,
        'text-valign': 'bottom',
        'text-wrap': 'ellipsis',
        'width': 'data(size)',
      },
    },
    {
      selector: 'node.external',
      style: {
        'background-color': '#5f6b7a',
        'border-color': muted,
        'border-style': 'dashed',
        'opacity': 0.78,
      },
    },
    {
      selector: 'edge',
      style: {
        'curve-style': 'bezier',
        'line-color': 'data(color)',
        'opacity': 0.72,
        'target-arrow-color': 'data(color)',
        'target-arrow-shape': 'triangle',
        'width': 'data(width)',
      },
    },
    {
      selector: 'edge.cycle-edge',
      style: {
        'line-color': '#ff5f57',
        'line-style': 'dashed',
        'target-arrow-color': '#ff5f57',
        'width': 3,
      },
    },
    {
      selector: 'edge.candidate-edge',
      style: {
        'line-style': 'dashed',
        'opacity': 0.35,
      },
    },
    {
      selector: '.dimmed',
      style: {
        'opacity': 0.14,
      },
    },
    {
      selector: 'node.impact',
      style: {
        'border-color': focus,
        'border-width': 4,
        'opacity': 1,
      },
    },
    {
      selector: 'edge.impact-edge',
      style: {
        'line-color': focus,
        'opacity': 1,
        'target-arrow-color': focus,
        'width': 4,
      },
    },
    {
      selector: 'node.selected',
      style: {
        'border-color': '#ffffff',
        'border-width': 4,
        'opacity': 1,
      },
    },
  ];

  return stylesheet as cytoscape.StylesheetJson;
}

function applyImpactHighlight(cy: cytoscape.Core, graph: DependencyGraphData, nodeId: string) {
  const path = impactPath(graph, nodeId);
  cy.elements().addClass('dimmed');

  cy.getElementById(nodeId).removeClass('dimmed').addClass('selected');
  path.nodeIds.forEach(id => {
    cy.getElementById(id).removeClass('dimmed').addClass('impact');
  });
  path.edgeIds.forEach(id => {
    cy.getElementById(id).removeClass('dimmed').addClass('impact-edge');
  });
}

function clearImpactHighlight(cy: cytoscape.Core, selectedNodeId: string | null) {
  cy.elements().removeClass('dimmed impact impact-edge selected');
  if (selectedNodeId) {
    cy.getElementById(selectedNodeId).addClass('selected');
  }
}

function impactPath(graph: DependencyGraphData, nodeId: string): { nodeIds: string[]; edgeIds: string[] } {
  const incoming = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    if (!edge.verified) continue;
    const list = incoming.get(edge.target) ?? [];
    list.push(edge);
    incoming.set(edge.target, list);
  }

  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const queue = [nodeId];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    for (const edge of incoming.get(current) ?? []) {
      edgeIds.add(edge.id);
      if (!nodeIds.has(edge.source)) {
        nodeIds.add(edge.source);
        queue.push(edge.source);
      }
    }
  }

  return { nodeIds: Array.from(nodeIds), edgeIds: Array.from(edgeIds) };
}

function nodeColor(node: GraphNode): string {
  if (node.external) return '#5f6b7a';
  return node.classification ? CLASS_COLORS[node.classification] : '#7c8796';
}

function nodeSize(node: GraphNode): number {
  const debt = Math.max(0, Math.min(100, node.debtScore ?? 20));
  return 24 + Math.round(debt * 0.34);
}

function edgeWidth(kind: EdgeKind): number {
  if (kind === 'CALLS') return 3.2;
  if (kind === 'INCLUDES') return 1.3;
  return 2.1;
}

function kindLabel(kind: EdgeKind): string {
  return kind.replace('_', ' ');
}

function displayNumber(value?: number): string {
  return value === undefined ? '-' : value.toLocaleString();
}

function relativeDate(iso: string): string {
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return '-';
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 7) return `${days}d ago`;
  if (days < 31) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || fallback;
}
