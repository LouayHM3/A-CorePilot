import React, { useEffect, useMemo, useRef, useState } from 'react';
import cytoscape from 'cytoscape';
import { vscode } from '../vscodeApi';

type ClassLevel = 'A' | 'B' | 'C' | 'D';
type RiskLevel = 'Low' | 'Medium' | 'High' | 'Critical';
type EdgeKind = 'CALLS' | 'INCLUDES' | 'USES_TABLE' | 'ENHANCES';
type EdgeSource = 'ADT_WHERE_USED' | 'SOURCE_PATTERN' | 'LLM' | 'ATC_FINDING';
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
  cycle: boolean;
}

interface GraphCycle {
  id: string;
  nodeIds: string[];
  edgeIds: string[];
}

interface DependencyGraphData {
  version: 1;
  generatedAt: string;
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
}

const CLASS_COLORS: Record<ClassLevel, string> = {
  A: '#8c8c8c',
  B: '#52c41a',
  C: '#f5c542',
  D: '#ff5f57',
};

const KIND_COLORS: Record<EdgeKind, string> = {
  CALLS: '#4da3ff',
  INCLUDES: '#a6a6a6',
  USES_TABLE: '#16b6a5',
  ENHANCES: '#d783ff',
};

const INITIAL_KIND_FILTER: Record<EdgeKind, boolean> = {
  CALLS: true,
  INCLUDES: true,
  USES_TABLE: true,
  ENHANCES: true,
};

export default function DependencyGraphView({ onStartScan }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const selectedNodeRef = useRef<string | null>(null);

  const [graph, setGraph] = useState<DependencyGraphData | null>(null);
  const [classFilter, setClassFilter] = useState<ClassFilter>('all');
  const [packageFilter, setPackageFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<Record<EdgeKind, boolean>>(INITIAL_KIND_FILTER);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [missingGraph, setMissingGraph] = useState(false);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'scanComplete' && msg.dependencyGraph) {
        setGraph(msg.dependencyGraph);
        setMissingGraph(false);
      }
      if (msg.type === 'dependencyGraphLoaded' && msg.dependencyGraph) {
        setGraph(msg.dependencyGraph);
        setMissingGraph(false);
      }
      if (msg.type === 'noDependencyGraph' || msg.type === 'noScanResults') {
        setMissingGraph(true);
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

    return graph.nodes.filter(node => {
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
      return classOk && packageOk && searchOk;
    });
  }, [graph, classFilter, packageFilter, searchQuery]);

  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map(node => node.id)), [visibleNodes]);

  const visibleEdges = useMemo(() => {
    if (!graph) return [];
    return graph.edges.filter(edge =>
      kindFilter[edge.kind] &&
      visibleNodeIds.has(edge.source) &&
      visibleNodeIds.has(edge.target)
    );
  }, [graph, kindFilter, visibleNodeIds]);

  const selectedNode = useMemo(
    () => graph?.nodes.find(node => node.id === selectedNodeId) ?? null,
    [graph, selectedNodeId]
  );

  const incomingEdges = useMemo(
    () => graph?.edges.filter(edge => edge.target === selectedNodeId) ?? [],
    [graph, selectedNodeId]
  );

  const outgoingEdges = useMemo(
    () => graph?.edges.filter(edge => edge.source === selectedNodeId) ?? [],
    [graph, selectedNodeId]
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
    if (!containerRef.current || !graph) return;

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
  }, [graph, visibleNodes, visibleEdges]);

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
        <span>Internal {graph.stats.internalNodeCount}</span>
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
        <Metric label="Callers" value={displayNumber(node.callerCount)} />
        <Metric label="Deps" value={displayNumber(node.calleeCount)} />
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
      classes: edge.cycle ? 'cycle-edge' : '',
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
