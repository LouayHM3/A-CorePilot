import { DependencyGraphEdge, DependencyGraphNode, SerializedDependencyGraph } from './DependencyGraph';

export function generateDependencyGraphMarkdown(graph: SerializedDependencyGraph): string {
  const lookup = new Map(graph.nodes.map(node => [node.id, node]));
  const lines: string[] = [];

  lines.push('## Dependency Graph');
  lines.push('');
  lines.push(`Generated: ${graph.generatedAt}`);
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---:|');
  lines.push(`| Nodes | ${graph.stats.nodeCount} |`);
  lines.push(`| Internal nodes | ${graph.stats.internalNodeCount} |`);
  lines.push(`| External nodes | ${graph.stats.externalNodeCount} |`);
  lines.push(`| Edges | ${graph.stats.edgeCount} |`);
  lines.push(`| Cycles | ${graph.stats.cycleCount} |`);
  lines.push('');

  appendNodePath(lines, '### Critical Path', graph.criticalPath ?? [], lookup);
  appendNodePath(lines, '### Migration Order', graph.topologicalOrder.filter(id => !lookup.get(id)?.external), lookup);
  appendCycles(lines, graph, lookup);
  appendValidatedEdges(lines, graph.edges, lookup);

  return lines.join('\n');
}

function appendNodePath(
  lines: string[],
  title: string,
  nodeIds: string[],
  lookup: Map<string, DependencyGraphNode>
): void {
  lines.push(title);
  lines.push('');

  if (nodeIds.length === 0) {
    lines.push('_None._');
    lines.push('');
    return;
  }

  lines.push('| # | Object | Type | Class | Debt | Depth |');
  lines.push('|---:|---|---|---|---:|---:|');
  nodeIds.slice(0, 25).forEach((nodeId, index) => {
    const node = lookup.get(nodeId);
    lines.push(`| ${index + 1} | ${node?.name ?? nodeId} | ${node?.type ?? '-'} | ${node?.classification ?? '-'} | ${node?.debtScore ?? '-'} | ${node?.graphDepth ?? '-'} |`);
  });
  if (nodeIds.length > 25) {
    lines.push(`|  | +${nodeIds.length - 25} more |  |  |  |  |`);
  }
  lines.push('');
}

function appendCycles(
  lines: string[],
  graph: SerializedDependencyGraph,
  lookup: Map<string, DependencyGraphNode>
): void {
  lines.push('### Circular Dependencies');
  lines.push('');

  if (graph.cycles.length === 0) {
    lines.push('_None detected._');
    lines.push('');
    return;
  }

  for (const cycle of graph.cycles) {
    const names = cycle.nodeIds.map(nodeId => lookup.get(nodeId)?.name ?? nodeId);
    lines.push(`- ${names.join(' -> ')}`);
  }
  lines.push('');
}

function appendValidatedEdges(
  lines: string[],
  edges: DependencyGraphEdge[],
  lookup: Map<string, DependencyGraphNode>
): void {
  const validated = edges.filter(edge => edge.validatedByAtc).slice(0, 30);
  lines.push('### ATC-Validated Edges');
  lines.push('');

  if (validated.length === 0) {
    lines.push('_None._');
    lines.push('');
    return;
  }

  lines.push('| Source | Relation | Target | Evidence |');
  lines.push('|---|---|---|---|');
  for (const edge of validated) {
    const source = lookup.get(edge.source)?.name ?? edge.source;
    const target = lookup.get(edge.target)?.name ?? edge.target;
    const evidence = (edge.evidence[0] ?? edge.rawText ?? '').replace(/\|/g, '\\|');
    lines.push(`| ${source} | ${edge.kind} | ${target} | ${evidence} |`);
  }
  lines.push('');
}
