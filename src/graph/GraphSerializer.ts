import * as fs from 'fs';
import * as path from 'path';
import { EnrichedObject } from '../sap/ObjectDiscovery';
import { DependencyGraph, SerializedDependencyGraph } from './DependencyGraph';

export function buildDependencyGraph(objects: EnrichedObject[]): SerializedDependencyGraph {
  const graph = DependencyGraph.fromObjects(objects);
  graph.applyMetricsToObjects(objects);
  return graph.toJSON();
}

export function persistDependencyGraph(filePath: string, graph: SerializedDependencyGraph): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(graph, null, 2), 'utf-8');
}

export function loadDependencyGraph(filePath: string): SerializedDependencyGraph | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as SerializedDependencyGraph;
    if (parsed.version !== 1 || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
