import type { AtcFinding, ModificationType } from '../sap/ObjectDiscovery';

export type ModificationTypeConfidence = 'high' | 'medium' | 'low';
export type ModificationTypeSource = 'SAP_METADATA' | 'ATC_FINDING' | 'SOURCE_PATTERN' | 'NAME_DESCRIPTION' | 'DEFAULT';

export interface ModificationTypeClassification {
  type: ModificationType;
  confidence: ModificationTypeConfidence;
  source: ModificationTypeSource;
  evidence: string;
}

export interface ModificationTypeInput {
  name: string;
  type?: string;
  description?: string;
  sourceCode?: string;
  atcFindings?: AtcFinding[];
}

/**
 * Deterministic R5 classifier. Rules are ordered from strongest/most risky
 * evidence to the safest default so the result is reproducible and auditable.
 */
export function classifyModificationType(input: ModificationTypeInput): ModificationTypeClassification {
  const name = normalize(input.name);
  const description = normalize(input.description ?? '');
  const sourceCode = normalize(stripAbapComments(input.sourceCode ?? ''));
  const atcText = normalize((input.atcFindings ?? []).map(f => `${f.checkId} ${f.message}`).join('\n'));
  const metadata = `${name}\n${description}`;
  const allEvidence = `${metadata}\n${atcText}\n${sourceCode}`;

  if (/CLASSICAL[ _-]+MODIFICATION|MODIFICATION ASSISTANT|MODIFIED SAP (?:STANDARD )?OBJECT/.test(atcText)) {
    return result('CLASSICAL_MODIFICATION', 'high', 'ATC_FINDING', matchingLine(atcText, /MODIFIC/));
  }

  if (/IMPLICIT[ _-]+ENHANCEMENT/.test(`${description}\n${atcText}`)) {
    return result('IMPLICIT_ENHANCEMENT', 'high', atcText.includes('IMPLICIT') ? 'ATC_FINDING' : 'SAP_METADATA', matchingLine(allEvidence, /IMPLICIT[ _-]+ENHANCEMENT/));
  }

  if (/EXPLICIT[ _-]+ENHANCEMENT/.test(`${description}\n${atcText}`)) {
    return result('EXPLICIT_ENHANCEMENT', 'high', atcText.includes('EXPLICIT') ? 'ATC_FINDING' : 'SAP_METADATA', matchingLine(allEvidence, /EXPLICIT[ _-]+ENHANCEMENT/));
  }

  const explicitSource = sourceCode.match(/\bENHANCEMENT-(?:POINT|SECTION)\b[^.]*\./);
  if (explicitSource) {
    return result('EXPLICIT_ENHANCEMENT', 'high', 'SOURCE_PATTERN', explicitSource[0]);
  }

  const badiSource = sourceCode.match(/\b(?:INTERFACES\s+IF_EX_[A-Z0-9_/$-]+|GET\s+BADI\s+[A-Z0-9_/$-]+|CALL\s+BADI\s+[A-Z0-9_/$-]+)/);
  const badiMetadata = /\bBADI\s+(?:IMP\.?|IMPLEMENTATION)|\bBADI_IMPLEMENTATION\b/.test(`${description}\n${atcText}`);
  if (badiSource || badiMetadata) {
    return result(
      'BADI_IMPLEMENTATION',
      'high',
      badiSource ? 'SOURCE_PATTERN' : (atcText.includes('BADI') ? 'ATC_FINDING' : 'SAP_METADATA'),
      badiSource?.[0] ?? matchingLine(allEvidence, /BADI/)
    );
  }
  if (/^[ZY]CL_IM_/.test(name)) {
    return result('BADI_IMPLEMENTATION', 'medium', 'NAME_DESCRIPTION', `Object name matches ${name.match(/^[ZY]CL_IM_[A-Z0-9_/$-]+/)?.[0] ?? name}`);
  }

  const wrapperName = metadata.match(/\b(?:WRAPPER|PROXY|ADAPTER|FACADE)\b|(?:WRAPPER|PROXY|ADAPTER|FACADE)/);
  if (wrapperName) {
    const delegates = /\b(?:CALL\s+FUNCTION|CALL\s+METHOD|NEW\s+[A-Z]|[A-Z0-9_/$-]+\s*=>)/.test(sourceCode);
    return result(
      'WRAPPER_PROXY',
      delegates ? 'high' : 'medium',
      'NAME_DESCRIPTION',
      delegates ? `${wrapperName[0]}; delegation call found` : wrapperName[0]
    );
  }

  // A bare ENHANCEMENT implementation proves an enhancement but not whether
  // its hook is implicit or explicit. Do not invent that distinction.
  const ambiguousEnhancement = sourceCode.match(/\bENHANCEMENT\s+\d+\s+[ZY][A-Z0-9_/$-]*/);
  if (ambiguousEnhancement) {
    return result('CUSTOM_DEVELOPMENT', 'low', 'SOURCE_PATTERN', `Ambiguous enhancement syntax: ${ambiguousEnhancement[0]}`);
  }

  return result(
    'CUSTOM_DEVELOPMENT',
    /^[ZY]/.test(name) ? 'medium' : 'low',
    'DEFAULT',
    /^[ZY]/.test(name) ? 'Z/Y custom namespace; no stronger modification evidence' : 'No deterministic modification evidence'
  );
}

export function strongerModificationClassification(
  left: ModificationTypeClassification,
  right: ModificationTypeClassification
): ModificationTypeClassification {
  const confidenceRank: Record<ModificationTypeConfidence, number> = { low: 1, medium: 2, high: 3 };
  const riskRank: Record<ModificationType, number> = {
    WRAPPER_PROXY: 1,
    CUSTOM_DEVELOPMENT: 2,
    BADI_IMPLEMENTATION: 3,
    EXPLICIT_ENHANCEMENT: 4,
    IMPLICIT_ENHANCEMENT: 5,
    CLASSICAL_MODIFICATION: 6,
  };
  const confidenceDelta = confidenceRank[right.confidence] - confidenceRank[left.confidence];
  if (confidenceDelta > 0) return right;
  if (confidenceDelta < 0) return left;
  return riskRank[right.type] > riskRank[left.type] ? right : left;
}

function result(
  type: ModificationType,
  confidence: ModificationTypeConfidence,
  source: ModificationTypeSource,
  evidence: string
): ModificationTypeClassification {
  return { type, confidence, source, evidence: evidence.slice(0, 300) };
}

function normalize(value: string): string {
  return value.replace(/\r/g, '').trim().toUpperCase();
}

function matchingLine(text: string, pattern: RegExp): string {
  return text.split('\n').find(line => pattern.test(line))?.trim() ?? 'Matching deterministic rule';
}

function stripAbapComments(source: string): string {
  return source
    .split(/\r?\n/)
    .filter(line => !/^\s*\*/.test(line))
    .map(line => line.replace(/".*$/, ''))
    .join('\n');
}
