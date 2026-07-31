import { AtcFinding } from '../sap/ObjectDiscovery';

export type ModificationType =
  | 'CLASSICAL_MODIFICATION'
  | 'IMPLICIT_ENHANCEMENT'
  | 'EXPLICIT_ENHANCEMENT'
  | 'BADI_IMPLEMENTATION'
  | 'CUSTOM_DEVELOPMENT'
  | 'WRAPPER_PROXY';

export interface SapObjectMetrics {
  atcFindings: AtcFinding[];
  loc: number;
  graphDepth: number;
  modType: ModificationType;
  lastChangedDate: string;
}

const WEIGHTS = {
  atcFindings: 0.30,
  linesOfCode: 0.20,
  graphDepth: 0.20,
  modificationType: 0.20,
  objectAge: 0.10,
};

const MOD_TYPE_MULTIPLIERS: Record<ModificationType, number> = {
  CLASSICAL_MODIFICATION: 1.0,
  IMPLICIT_ENHANCEMENT: 0.80,
  EXPLICIT_ENHANCEMENT: 0.65,
  BADI_IMPLEMENTATION: 0.40,
  CUSTOM_DEVELOPMENT: 0.25,
  WRAPPER_PROXY: 0.10,
};

const LOC_SATURATION = 2000;
const DEPTH_SATURATION = 10;
const AGE_SATURATION_DAYS = 1825;

function daysBetween(d1Str: string, d2: Date): number {
  if (!d1Str) return 0;
  const d1 = new Date(d1Str);
  if (isNaN(d1.getTime())) return 0;
  const diffTime = Math.abs(d2.getTime() - d1.getTime());
  return Math.floor(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * ATC Severity Weighting Formula:
 * - Priority 1 (Error) = 10 points
 * - Priority 2 (Warning) = 5 points
 * - Priority 3 (Info) = 1 point
 */
export function computeAtcDebtScore(findings: AtcFinding[]): number {
  return (findings || []).reduce((sum, f) => {
    if (f.priority === 1) return sum + 10;
    if (f.priority === 2) return sum + 5;
    if (f.priority === 3) return sum + 1;
    return sum;
  }, 0);
}

/**
 * Composite Technical Debt Score (Normalized 0–100)
 */
export function computeCompositeDebtScore(object: SapObjectMetrics): number {
  const rawAtcScore = computeAtcDebtScore(object.atcFindings);
  const normalizedFindings = Math.min(1, rawAtcScore / 100);
  const normalizedLoc = Math.min(1, (object.loc || 0) / LOC_SATURATION);
  const normalizedDepth = Math.min(1, (object.graphDepth || 0) / DEPTH_SATURATION);
  const modTypeKey = object.modType || 'CUSTOM_DEVELOPMENT';
  const modMultiplier = MOD_TYPE_MULTIPLIERS[modTypeKey] ?? 0.25;
  const ageDays = object.lastChangedDate ? daysBetween(object.lastChangedDate, new Date()) : 0;
  const normalizedAge = Math.min(1, ageDays / AGE_SATURATION_DAYS);

  return Math.round(
    (WEIGHTS.atcFindings * normalizedFindings +
      WEIGHTS.linesOfCode * normalizedLoc +
      WEIGHTS.graphDepth * normalizedDepth +
      WEIGHTS.modificationType * modMultiplier +
      WEIGHTS.objectAge * normalizedAge) *
      100
  );
}

const SP_BY_CLASSIFICATION: Record<'A' | 'B' | 'C' | 'D', number> = {
  A: 1,  // Delete: trivial
  B: 3,  // Minor adapt: small
  C: 8,  // Replace/wrap: medium sprint
  D: 21, // Full rework: large
};

/**
 * Story Point Effort Estimation
 */
export function computeEffortSP(level: 'A' | 'B' | 'C' | 'D' | undefined, graphDepth: number): number {
  const safeLevel = level && SP_BY_CLASSIFICATION[level] ? level : 'A';
  const base = SP_BY_CLASSIFICATION[safeLevel];
  const depMultiplier = 1 + Math.min(1, (graphDepth || 0) / DEPTH_SATURATION);
  return Math.ceil(base * depMultiplier);
}
