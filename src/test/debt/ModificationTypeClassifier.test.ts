import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyModificationType, strongerModificationClassification } from '../../debt/ModificationTypeClassifier';

test('classifies classical modifications from ATC evidence', () => {
  const result = classifyModificationType({
    name: 'SAPLFOO',
    atcFindings: [{ checkId: 'MOD', priority: 1, message: 'Modified SAP standard object detected by Modification Assistant' }],
  });
  assert.equal(result.type, 'CLASSICAL_MODIFICATION');
  assert.equal(result.confidence, 'high');
});

test('classifies implicit and explicit enhancements from exact evidence', () => {
  assert.equal(classifyModificationType({ name: 'ZENH1', description: 'Implicit enhancement implementation' }).type, 'IMPLICIT_ENHANCEMENT');
  assert.equal(classifyModificationType({ name: 'ZENH2', sourceCode: 'ENHANCEMENT-POINT spot1 SPOTS es_spot.' }).type, 'EXPLICIT_ENHANCEMENT');
});

test('classifies BAdI implementations from source and naming conventions', () => {
  const exact = classifyModificationType({ name: 'ZCL_HANDLER', sourceCode: 'INTERFACES if_ex_mb_res_bapi_create1.' });
  assert.equal(exact.type, 'BADI_IMPLEMENTATION');
  assert.equal(exact.confidence, 'high');

  const named = classifyModificationType({ name: 'ZCL_IM_PURCHASE_ORDER' });
  assert.equal(named.type, 'BADI_IMPLEMENTATION');
  assert.equal(named.confidence, 'medium');
});

test('classifies wrappers only with explainable naming evidence', () => {
  const result = classifyModificationType({
    name: 'ZCL_TAX_WRAPPER',
    sourceCode: "CALL FUNCTION 'STANDARD_API'.",
  });
  assert.equal(result.type, 'WRAPPER_PROXY');
  assert.equal(result.confidence, 'high');
});

test('defaults ordinary Z objects to custom development without an LLM', () => {
  const result = classifyModificationType({ name: 'ZCL_ORDER_SERVICE', sourceCode: 'METHOD run. ENDMETHOD.' });
  assert.equal(result.type, 'CUSTOM_DEVELOPMENT');
  assert.equal(result.source, 'DEFAULT');
});

test('retains stronger source evidence when ATC has no stronger signal', () => {
  const sourceResult = classifyModificationType({ name: 'ZCL_HANDLER', sourceCode: 'INTERFACES if_ex_example.' });
  const atcResult = classifyModificationType({ name: 'ZCL_HANDLER', atcFindings: [] });
  assert.equal(strongerModificationClassification(sourceResult, atcResult).type, 'BADI_IMPLEMENTATION');
});
