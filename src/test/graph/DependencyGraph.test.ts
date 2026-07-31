import test from 'node:test';
import assert from 'node:assert/strict';
import { DependencyGraph } from '../../graph/DependencyGraph';
import {
  EnrichedObject,
  extractAtcDependencies,
  extractSourceDependencies,
  parseWhereUsedReferences,
} from '../../sap/ObjectDiscovery';

function sapObject(overrides: Partial<EnrichedObject>): EnrichedObject {
  return {
    name: 'ZCL_DEFAULT',
    type: 'CLAS',
    uri: '',
    packageName: 'ZPKG',
    description: '',
    callerCount: 0,
    calleeCount: 0,
    callers: [],
    dependencies: [],
    graphDepth: 0,
    changesLast12Months: 0,
    lastChangedDate: '',
    loc: 0,
    classification: 'B',
    atcFindings: [],
    atcFindingsCount: 0,
    modType: 'CUSTOM_DEVELOPMENT',
    crvEntry: undefined,
    debtScore: 0,
    effortSP: 0,
    riskScore: undefined,
    riskLevel: undefined,
    riskDimensions: undefined,
    riskAdvisory: undefined,
    ...overrides,
  };
}

test('builds graph edges, metrics, cycles, and critical path', () => {
  const objects = [
    sapObject({
      name: 'ZCL_ORDER_SERVICE',
      debtScore: 42,
      callers: [{ name: 'ZREP_ORDER_UI', type: 'PROG' }],
      dependencies: [
        { name: 'ZCL_ORDER_REPO', type: 'CLAS', kind: 'CALLS', source: 'SOURCE_PATTERN', confidence: 'high' },
        { name: 'ZORDER_TABLE', type: 'TABL', kind: 'USES_TABLE', source: 'SOURCE_PATTERN', confidence: 'medium' },
      ],
    }),
    sapObject({
      name: 'ZCL_ORDER_REPO',
      dependencies: [
        { name: 'ZCL_ORDER_SERVICE', type: 'CLAS', kind: 'CALLS', source: 'SOURCE_PATTERN', confidence: 'high' },
      ],
    }),
  ];

  const graph = DependencyGraph.fromObjects(objects);
  graph.applyMetricsToObjects(objects);
  const json = graph.toJSON('2026-07-29T00:00:00.000Z');

  assert.equal(json.stats.nodeCount, 4);
  assert.equal(json.stats.edgeCount, 4);
  assert.equal(json.stats.cycleCount, 1);
  assert.equal(json.topologicalOrder.length, 4);
  assert.ok(json.criticalPath.length >= 2);
  assert.equal(objects[0].calleeCount, 2);
  assert.equal(objects[0].callerCount, 2);
  assert.equal(objects[0].graphDepth, 2);
  assert.ok(json.edges.some(edge => edge.cycle));
});

test('merges ATC evidence into an existing edge and upgrades confidence', () => {
  const objects = [
    sapObject({
      name: 'ZCL_ORDER_SERVICE',
      dependencies: [
        {
          name: 'ZCL_ORDER_REPO',
          type: 'CLAS',
          kind: 'CALLS',
          source: 'SOURCE_PATTERN',
          confidence: 'medium',
          rawText: 'ZCL_ORDER_REPO=>SAVE',
        },
        {
          name: 'ZCL_ORDER_REPO',
          type: 'CLAS',
          kind: 'CALLS',
          source: 'ATC_FINDING',
          confidence: 'high',
          rawText: 'CL_CI_TEST_CLOUDIFICATION: ZCL_ORDER_REPO',
        },
      ],
    }),
  ];

  const json = DependencyGraph.fromObjects(objects).toJSON();
  const edge = json.edges.find(item => item.target === 'CLAS::ZCL_ORDER_REPO');

  assert.ok(edge);
  assert.equal(json.stats.edgeCount, 1);
  assert.equal(edge?.confidence, 'high');
  assert.equal(edge?.validatedByAtc, true);
  assert.deepEqual(edge?.sourceTypes.sort(), ['ATC_FINDING', 'SOURCE_PATTERN']);
  assert.equal(edge?.evidence.length, 2);
});

test('extracts common ABAP source dependencies', () => {
  const source = `
    CALL FUNCTION 'Z_FM_CREATE_ORDER'.
    DATA(repo) = NEW zcl_order_repo( ).
    zcl_order_repo=>save( ).
    SUBMIT zreport_invoice.
    INCLUDE zinclude_shared.
    SELECT * FROM zorder_table INTO TABLE @DATA(rows).
    GET BADI zbadi_order_hook.
  `;

  const deps = extractSourceDependencies(source, 'ZCL_ORDER_SERVICE');
  const keys = deps.map(dep => `${dep.kind}:${dep.type}:${dep.name}`).sort();

  assert.ok(keys.includes('CALLS:FUNC:Z_FM_CREATE_ORDER'));
  assert.ok(keys.includes('CALLS:CLAS:ZCL_ORDER_REPO'));
  assert.ok(keys.includes('CALLS:PROG:ZREPORT_INVOICE'));
  assert.ok(keys.includes('INCLUDES:PROG:ZINCLUDE_SHARED'));
  assert.ok(keys.includes('USES_TABLE:TABL:ZORDER_TABLE'));
  assert.ok(keys.includes('ENHANCES:BADI:ZBADI_ORDER_HOOK'));
});

test('extracts ATC finding references as high-confidence dependencies', () => {
  const deps = extractAtcDependencies([
    {
      checkId: 'CL_CI_TEST_CLOUDIFICATION',
      priority: 1,
      message: 'Use of non-released API ZCL_OLD_API in custom code',
      location: 'CLAS/ZCL_ORDER_SERVICE',
    },
    {
      checkId: 'CL_CI_TEST_SELECT',
      priority: 2,
      message: 'Direct database access to table ZORDER_TABLE',
      location: 'CLAS/ZCL_ORDER_SERVICE',
    },
  ], 'ZCL_ORDER_SERVICE');

  assert.ok(deps.some(dep => dep.name === 'ZCL_OLD_API' && dep.kind === 'CALLS' && dep.confidence === 'high'));
  assert.ok(deps.some(dep => dep.name === 'ZORDER_TABLE' && dep.kind === 'USES_TABLE' && dep.confidence === 'high'));
  assert.ok(deps.every(dep => dep.source === 'ATC_FINDING'));
});

test('parses ADT where-used references into caller nodes', () => {
  const xml = `
    <ris:usageReferences>
      <adtcore:objectReference adtcore:name="ZCL_ORDER_SERVICE" adtcore:type="CLAS" adtcore:uri="/sap/bc/adt/oo/classes/ZCL_ORDER_SERVICE"/>
      <adtcore:objectReference adtcore:name="ZREP_ORDER_UI" adtcore:type="PROG" adtcore:uri="/sap/bc/adt/programs/programs/ZREP_ORDER_UI"/>
    </ris:usageReferences>
  `;

  const refs = parseWhereUsedReferences(xml, 'ZCL_ORDER_SERVICE', 'CLAS');

  assert.equal(refs.length, 1);
  assert.equal(refs[0].name, 'ZREP_ORDER_UI');
  assert.equal(refs[0].type, 'PROG');
});
