import {
  DependencyConfidence,
  DependencyKind,
  DependencyReference,
  DependencySource,
  EnrichedObject,
} from '../sap/ObjectDiscovery';

export interface DependencyGraphNode {
  id: string;
  name: string;
  type: string;
  packageName: string;
  description: string;
  classification?: 'A' | 'B' | 'C' | 'D';
  debtScore?: number;
  effortSP?: number;
  riskScore?: number;
  riskLevel?: 'Low' | 'Medium' | 'High' | 'Critical';
  loc: number;
  callerCount: number;
  calleeCount: number;
  graphDepth: number;
  external: boolean;
}

export interface DependencyGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: DependencyKind;
  sourceType: DependencySource;
  sourceTypes: DependencySource[];
  confidence: DependencyConfidence;
  label: string;
  rawText?: string;
  evidence: string[];
  validatedByAtc: boolean;
  cycle: boolean;
}

export interface DependencyGraphCycle {
  id: string;
  nodeIds: string[];
  edgeIds: string[];
}

export interface DependencyGraphStats {
  nodeCount: number;
  edgeCount: number;
  internalNodeCount: number;
  externalNodeCount: number;
  cycleCount: number;
}

export interface SerializedDependencyGraph {
  version: 1;
  generatedAt: string;
  nodes: DependencyGraphNode[];
  edges: DependencyGraphEdge[];
  cycles: DependencyGraphCycle[];
  topologicalOrder: string[];
  criticalPath: string[];
  stats: DependencyGraphStats;
}

interface EdgeDraft {
  source: string;
  target: string;
  kind: DependencyKind;
  sourceType: DependencySource;
  confidence: DependencyConfidence;
  rawText?: string;
}

export class DependencyGraph {
  private readonly nodesById = new Map<string, DependencyGraphNode>();
  private readonly edgesById = new Map<string, DependencyGraphEdge>();

  static fromObjects(objects: EnrichedObject[]): DependencyGraph {
    const graph = new DependencyGraph();

    for (const obj of objects) {
      graph.addNode(nodeFromObject(obj));
    }

    for (const obj of objects) {
      const objectId = objectIdFor(obj.type, obj.name);

      for (const caller of obj.callers ?? []) {
        const callerNode = nodeFromReference(caller);
        graph.addNode(callerNode);
        graph.addEdge({
          source: callerNode.id,
          target: objectId,
          kind: 'CALLS',
          sourceType: 'ADT_WHERE_USED',
          confidence: 'high',
        });
      }

      for (const dependency of obj.dependencies ?? []) {
        const dependencyNode = nodeFromReference(dependency);
        graph.addNode(dependencyNode);
        graph.addEdge({
          source: objectId,
          target: dependencyNode.id,
          kind: dependency.kind,
          sourceType: dependency.source,
          confidence: dependency.confidence,
          rawText: dependency.rawText,
        });
      }
    }

    graph.refreshMetrics();
    return graph;
  }

  get nodes(): DependencyGraphNode[] {
    return Array.from(this.nodesById.values());
  }

  get edges(): DependencyGraphEdge[] {
    return Array.from(this.edgesById.values());
  }

  applyMetricsToObjects(objects: EnrichedObject[]): void {
    const depths = this.computeDepths();
    const incomingCalls = this.countIncomingCalls();
    const outgoingDependencies = this.countOutgoingDependencies();

    for (const obj of objects) {
      const id = objectIdFor(obj.type, obj.name);
      obj.calleeCount = outgoingDependencies.get(id) ?? 0;
      obj.graphDepth = depths.get(id) ?? 0;
      obj.callerCount = Math.max(obj.callerCount || 0, incomingCalls.get(id) ?? 0);
    }
  }

  impactOf(nodeId: string): string[] {
    const reverse = this.buildReverseAdjacency();
    const impacted = new Set<string>();
    const queue = [...(reverse.get(nodeId) ?? [])];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || impacted.has(current)) continue;
      impacted.add(current);
      queue.push(...(reverse.get(current) ?? []));
    }

    return Array.from(impacted);
  }

  detectCycles(): DependencyGraphCycle[] {
    const adjacency = this.buildAdjacency();
    const state = new Map<string, 'visiting' | 'done'>();
    const stack: string[] = [];
    const cycles = new Map<string, DependencyGraphCycle>();

    const visit = (nodeId: string): void => {
      state.set(nodeId, 'visiting');
      stack.push(nodeId);

      for (const target of adjacency.get(nodeId) ?? []) {
        const targetState = state.get(target);
        if (targetState === 'visiting') {
          const start = stack.indexOf(target);
          if (start >= 0) {
            const nodeIds = stack.slice(start);
            const key = canonicalCycleKey(nodeIds);
            if (!cycles.has(key)) {
              const edgeIds = this.edgeIdsForCycle(nodeIds);
              cycles.set(key, {
                id: `cycle-${cycles.size + 1}`,
                nodeIds,
                edgeIds,
              });
            }
          }
          continue;
        }

        if (!targetState) {
          visit(target);
        }
      }

      stack.pop();
      state.set(nodeId, 'done');
    };

    for (const nodeId of this.nodesById.keys()) {
      if (!state.has(nodeId)) {
        visit(nodeId);
      }
    }

    return Array.from(cycles.values());
  }

  topoSort(): string[] {
    const adjacency = this.buildAdjacency();
    const indegree = new Map<string, number>();

    for (const nodeId of this.nodesById.keys()) {
      indegree.set(nodeId, 0);
    }

    for (const targets of adjacency.values()) {
      for (const target of targets) {
        indegree.set(target, (indegree.get(target) ?? 0) + 1);
      }
    }

    const queue = Array.from(indegree.entries())
      .filter(([, degree]) => degree === 0)
      .map(([nodeId]) => nodeId)
      .sort();
    const ordered: string[] = [];

    while (queue.length > 0) {
      const nodeId = queue.shift();
      if (!nodeId) break;
      ordered.push(nodeId);

      for (const target of adjacency.get(nodeId) ?? []) {
        const nextDegree = (indegree.get(target) ?? 0) - 1;
        indegree.set(target, nextDegree);
        if (nextDegree === 0) {
          queue.push(target);
          queue.sort();
        }
      }
    }

    const remaining = Array.from(this.nodesById.keys()).filter(nodeId => !ordered.includes(nodeId)).sort();
    return [...ordered, ...remaining];
  }

  criticalPath(): string[] {
    const adjacency = this.buildAdjacency();
    const memo = new Map<string, string[]>();
    const visiting = new Set<string>();

    const bestFrom = (nodeId: string): string[] => {
      if (memo.has(nodeId)) return memo.get(nodeId) ?? [nodeId];
      if (visiting.has(nodeId)) return [nodeId];

      visiting.add(nodeId);
      let bestPath = [nodeId];

      for (const target of adjacency.get(nodeId) ?? []) {
        const candidate = [nodeId, ...bestFrom(target)];
        if (candidate.length > bestPath.length) {
          bestPath = candidate;
        }
      }

      visiting.delete(nodeId);
      memo.set(nodeId, bestPath);
      return bestPath;
    };

    let best: string[] = [];
    for (const nodeId of this.nodesById.keys()) {
      const candidate = bestFrom(nodeId);
      if (candidate.length > best.length) {
        best = candidate;
      }
    }

    return best;
  }

  toJSON(generatedAt = new Date().toISOString()): SerializedDependencyGraph {
    const cycles = this.detectCycles();
    const cycleEdgeIds = new Set(cycles.flatMap(cycle => cycle.edgeIds));
    const nodes = this.nodes;
    const edges = this.edges.map(edge => ({ ...edge, cycle: cycleEdgeIds.has(edge.id) }));

    return {
      version: 1,
      generatedAt,
      nodes,
      edges,
      cycles,
      topologicalOrder: this.topoSort(),
      criticalPath: this.criticalPath(),
      stats: {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        internalNodeCount: nodes.filter(node => !node.external).length,
        externalNodeCount: nodes.filter(node => node.external).length,
        cycleCount: cycles.length,
      },
    };
  }

  private addNode(node: DependencyGraphNode): void {
    const existing = this.nodesById.get(node.id);
    if (!existing || (existing.external && !node.external)) {
      this.nodesById.set(node.id, node);
      return;
    }

    existing.callerCount = Math.max(existing.callerCount, node.callerCount);
    existing.calleeCount = Math.max(existing.calleeCount, node.calleeCount);
    existing.graphDepth = Math.max(existing.graphDepth, node.graphDepth);
  }

  private addEdge(edge: EdgeDraft): void {
    if (edge.source === edge.target) return;

    const id = edgeIdFor(edge.source, edge.target, edge.kind);
    const existing = this.edgesById.get(id);
    if (existing) {
      if (!existing.sourceTypes.includes(edge.sourceType)) {
        existing.sourceTypes.push(edge.sourceType);
      }
      existing.confidence = strongerConfidence(existing.confidence, edge.confidence);
      existing.validatedByAtc = existing.validatedByAtc || edge.sourceType === 'ATC_FINDING';
      if (edge.rawText && !existing.evidence.includes(edge.rawText)) {
        existing.evidence.push(edge.rawText);
      }
      if (!existing.rawText && edge.rawText) {
        existing.rawText = edge.rawText;
      }
      return;
    }

    this.edgesById.set(id, {
      ...edge,
      id,
      sourceTypes: [edge.sourceType],
      label: edge.kind.replace('_', ' '),
      evidence: edge.rawText ? [edge.rawText] : [],
      validatedByAtc: edge.sourceType === 'ATC_FINDING',
      cycle: false,
    });
  }

  private refreshMetrics(): void {
    const depths = this.computeDepths();
    const incomingCalls = this.countIncomingCalls();
    const outgoingDependencies = this.countOutgoingDependencies();

    for (const node of this.nodesById.values()) {
      node.callerCount = Math.max(node.callerCount, incomingCalls.get(node.id) ?? 0);
      node.calleeCount = outgoingDependencies.get(node.id) ?? node.calleeCount;
      node.graphDepth = depths.get(node.id) ?? node.graphDepth;
    }
  }

  private countIncomingCalls(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const edge of this.edgesById.values()) {
      if (edge.kind !== 'CALLS') continue;
      counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
    }
    return counts;
  }

  private countOutgoingDependencies(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const edge of this.edgesById.values()) {
      counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
    }
    return counts;
  }

  private computeDepths(): Map<string, number> {
    const adjacency = this.buildAdjacency();
    const memo = new Map<string, number>();
    const visiting = new Set<string>();

    const depth = (nodeId: string): number => {
      if (memo.has(nodeId)) return memo.get(nodeId) ?? 0;
      if (visiting.has(nodeId)) return 0;

      visiting.add(nodeId);
      let maxDepth = 0;
      for (const target of adjacency.get(nodeId) ?? []) {
        maxDepth = Math.max(maxDepth, 1 + depth(target));
      }
      visiting.delete(nodeId);
      memo.set(nodeId, maxDepth);
      return maxDepth;
    };

    for (const nodeId of this.nodesById.keys()) {
      depth(nodeId);
    }

    return memo;
  }

  private buildAdjacency(): Map<string, string[]> {
    const adjacency = new Map<string, Set<string>>();
    for (const nodeId of this.nodesById.keys()) {
      adjacency.set(nodeId, new Set());
    }
    for (const edge of this.edgesById.values()) {
      adjacency.get(edge.source)?.add(edge.target);
    }
    return mapSetsToSortedArrays(adjacency);
  }

  private buildReverseAdjacency(): Map<string, string[]> {
    const adjacency = new Map<string, Set<string>>();
    for (const nodeId of this.nodesById.keys()) {
      adjacency.set(nodeId, new Set());
    }
    for (const edge of this.edgesById.values()) {
      adjacency.get(edge.target)?.add(edge.source);
    }
    return mapSetsToSortedArrays(adjacency);
  }

  private edgeIdsForCycle(nodeIds: string[]): string[] {
    const edgeIds: string[] = [];
    for (let i = 0; i < nodeIds.length; i++) {
      const source = nodeIds[i];
      const target = nodeIds[(i + 1) % nodeIds.length];
      for (const edge of this.edgesById.values()) {
        if (edge.source === source && edge.target === target) {
          edgeIds.push(edge.id);
        }
      }
    }
    return edgeIds;
  }
}

export function objectIdFor(type: string, name: string): string {
  return `${normalizeType(type)}::${normalizeName(name)}`;
}

function edgeIdFor(source: string, target: string, kind: DependencyKind): string {
  return `${source}->${target}:${kind}`;
}

function normalizeName(name: string): string {
  return (name || '').trim().toUpperCase();
}

function normalizeType(type: string): string {
  return (type || 'UNKNOWN').trim().split('/')[0].toUpperCase();
}

function nodeFromObject(obj: EnrichedObject): DependencyGraphNode {
  return {
    id: objectIdFor(obj.type, obj.name),
    name: normalizeName(obj.name),
    type: normalizeType(obj.type),
    packageName: obj.packageName || '',
    description: obj.description || '',
    classification: obj.classification,
    debtScore: obj.debtScore,
    effortSP: obj.effortSP,
    riskScore: obj.riskScore,
    riskLevel: obj.riskLevel,
    loc: obj.loc || 0,
    callerCount: obj.callerCount || 0,
    calleeCount: obj.calleeCount || 0,
    graphDepth: obj.graphDepth || 0,
    external: false,
  };
}

function nodeFromReference(ref: DependencyReference): DependencyGraphNode {
  return {
    id: objectIdFor(ref.type, ref.name),
    name: normalizeName(ref.name),
    type: normalizeType(ref.type),
    packageName: ref.packageName || '',
    description: ref.description || '',
    loc: 0,
    callerCount: 0,
    calleeCount: 0,
    graphDepth: 0,
    external: true,
  };
}

function canonicalCycleKey(nodeIds: string[]): string {
  return [...new Set(nodeIds)].sort().join('|');
}

function strongerConfidence(
  left: DependencyConfidence,
  right: DependencyConfidence
): DependencyConfidence {
  const rank: Record<DependencyConfidence, number> = {
    low: 1,
    medium: 2,
    high: 3,
  };
  return rank[right] > rank[left] ? right : left;
}

function mapSetsToSortedArrays(map: Map<string, Set<string>>): Map<string, string[]> {
  const normalized = new Map<string, string[]>();
  for (const [key, values] of map.entries()) {
    normalized.set(key, Array.from(values).sort());
  }
  return normalized;
}
