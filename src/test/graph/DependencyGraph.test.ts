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
      callers: [
        { name: 'ZREP_ORDER_UI', type: 'PROG', source: 'SAP_CROSSREF' },
        { name: 'ZCL_ORDER_REPO', type: 'CLAS', source: 'SAP_CROSSREF' },
      ],
      dependencies: [
        { name: 'ZCL_ORDER_REPO', type: 'CLAS', kind: 'CALLS', source: 'SOURCE_PATTERN', confidence: 'high' },
        { name: 'ZORDER_TABLE', type: 'TABL', kind: 'USES_TABLE', source: 'SOURCE_PATTERN', confidence: 'medium' },
      ],
    }),
    sapObject({
      name: 'ZCL_ORDER_REPO',
      callers: [{ name: 'ZCL_ORDER_SERVICE', type: 'CLAS', source: 'SAP_CROSSREF' }],
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
  assert.equal(objects[0].calleeCount, 1);
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

test('counts a main program as an incoming user of its includes', () => {
  const objects = [
    sapObject({
      name: 'ZCAP_1',
      type: 'PROG/P',
      dependencies: [
        { name: 'ZCAP_1_TOP', type: 'PROG', kind: 'INCLUDES', source: 'SOURCE_PATTERN', confidence: 'high' },
      ],
    }),
    sapObject({
      name: 'ZCAP_1_TOP',
      type: 'PROG/I',
      callerScanStatus: 'success',
      callers: [{ name: 'ZCAP_1', type: 'PROG', kind: 'INCLUDES', source: 'SAP_CROSSREF' }],
    }),
  ];

  const graph = DependencyGraph.fromObjects(objects);
  graph.applyMetricsToObjects(objects);

  assert.equal(objects[1].callerCount, 1);
  assert.deepEqual(graph.impactOf('PROG::ZCAP_1_TOP'), ['PROG::ZCAP_1']);
});

test('does not retain an anonymous caller count without an incoming edge', () => {
  const objects = [sapObject({
    name: 'ZABAPGIT_STANDALONE',
    type: 'PROG/P',
    callerCount: 1,
    callers: [],
  })];

  const graph = DependencyGraph.fromObjects(objects);
  graph.applyMetricsToObjects(objects);
  const json = graph.toJSON();

  assert.equal(objects[0].callerCount, 0);
  assert.equal(json.nodes[0].callerCount, 0);
  assert.equal(json.edges.filter(edge => edge.target === 'PROG::ZABAPGIT_STANDALONE').length, 0);
});

test('keeps source and ADT relations as candidates outside production metrics', () => {
  const objects = [
    sapObject({
      name: 'ZCL_SOURCE',
      callers: [{ name: 'ZREP_ADT_USER', type: 'PROG', source: 'ADT_WHERE_USED' }],
      dependencies: [
        { name: 'ZCL_TARGET', type: 'CLAS', kind: 'CALLS', source: 'SOURCE_PATTERN', confidence: 'high' },
      ],
    }),
    sapObject({ name: 'ZCL_TARGET' }),
  ];

  const graph = DependencyGraph.fromObjects(objects);
  graph.applyMetricsToObjects(objects);
  const json = graph.toJSON();

  assert.equal(objects[0].callerCount, 0);
  assert.equal(objects[0].calleeCount, 0);
  assert.equal(json.edges.filter(edge => edge.verified).length, 0);
  assert.equal(json.edges.length, 2);
});

test('models BAdI metadata and implemented interfaces with correct direction', () => {
  const source = 'CLASS zcl_im_mb_res_bapi_create1 DEFINITION. PUBLIC SECTION. INTERFACES if_ex_mb_res_bapi_create1. ENDCLASS.';
  const objects = [sapObject({
    name: 'ZCL_IM_MB_RES_BAPI_CREATE1',
    type: 'CLAS/OC',
    description: 'Imp. class for BAdI imp. ZMB_RES_BAPI_CREATE1',
    dependencies: extractSourceDependencies(source, 'ZCL_IM_MB_RES_BAPI_CREATE1'),
  })];

  const graph = DependencyGraph.fromObjects(objects);
  graph.applyMetricsToObjects(objects);
  const json = graph.toJSON();

  assert.ok(json.edges.some(edge => edge.source === 'BADI::ZMB_RES_BAPI_CREATE1' && edge.target === 'CLAS::ZCL_IM_MB_RES_BAPI_CREATE1' && edge.kind === 'BADI_IMPLEMENTATION'));
  assert.ok(json.edges.some(edge => edge.source === 'CLAS::ZCL_IM_MB_RES_BAPI_CREATE1' && edge.target === 'INTF::IF_EX_MB_RES_BAPI_CREATE1' && edge.kind === 'IMPLEMENTS'));
  // Description/source inference remains visible, but does not affect
  // production metrics until SAP metadata resolves both relations.
  assert.equal(objects[0].callerCount, 0);
  assert.equal(objects[0].calleeCount, 0);
  assert.equal(objects[0].impactCount, 0);
  assert.ok(json.edges.every(edge => edge.verified === false));
});

test('ignores ATC locations that point to a subobject of self', () => {
  const dependencies = extractAtcDependencies([{
    checkId: 'TEST',
    priority: 2,
    message: 'Finding in ZCL_IM_MB_RES_BAPI_CREATE1/SOME_METHOD',
    location: 'ZCL_IM_MB_RES_BAPI_CREATE1/SOME_METHOD',
  }], 'ZCL_IM_MB_RES_BAPI_CREATE1');

  assert.equal(dependencies.length, 0);
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
