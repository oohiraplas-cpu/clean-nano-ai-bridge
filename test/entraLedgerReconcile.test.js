'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reconcile } = require('../src/entraLedgerReconcile');

const OID_A = '11111111-1111-1111-1111-111111111111';
const OID_B = '22222222-2222-2222-2222-222222222222';
const OID_C = '33333333-3333-3333-3333-333333333333';

const entra = [
  { objectId: OID_A, displayName: '野口 英光', userPrincipalName: 's63@example.onmicrosoft.com', mail: 's63@example.onmicrosoft.com' },
  { objectId: OID_B, displayName: '箸中 雄也', userPrincipalName: 'yuya1@example.onmicrosoft.com', mail: null },
  { objectId: OID_C, displayName: '山田 悠弥', userPrincipalName: '001@example.onmicrosoft.com', mail: null },
];
const ledger = [
  { id: '1', fields: { Title: '野口英光', EntraObjectId: OID_A, EmailAddress: 'noguchi.private@gmail.com', EmployeeCategory: '一般社員' } },
  { id: '2', fields: { Title: '橋中 雄也', EntraObjectId: '', EmailAddress: '', EmployeeCategory: '' } },
  { id: '3', fields: { Title: '山田 悠弥', EntraObjectId: '', EmailAddress: '001@example.onmicrosoft.com', EmployeeCategory: '' } },
  { id: '4', fields: { Title: 'テスト太郎', EntraObjectId: '', EmailAddress: 'test@example.com', EmployeeCategory: 'アルバイト' } },
];

test('a ledger row linked by EntraObjectId is "linked", even when the name is written with different spacing', () => {
  const r = reconcile(entra, ledger).results[0];
  assert.equal(r.status, 'linked'); assert.equal(r.matchedByObjectId, true); assert.equal(r.matchedByName, true);
  assert.equal(r.ledgerEmailFilled, true); assert.equal(r.ledgerCategorySet, true);
});

test('a different kanji spelling is NOT treated as the same person (it stays "missing")', () => {
  const r = reconcile(entra, ledger).results[1];
  assert.equal(r.status, 'missing'); assert.equal(r.matchedByName, false); assert.equal(r.ledgerRowsMatched, 0);
});

test('a name or e-mail match without the EntraObjectId link is only a candidate', () => {
  const r = reconcile(entra, ledger).results[2];
  assert.equal(r.status, 'candidate_existing'); assert.equal(r.matchedByObjectId, false);
  assert.equal(r.matchedByName, true); assert.equal(r.matchedByEmail, true, 'ledger e-mail equals the Entra sign-in name');
  assert.equal(r.ledgerCategorySet, false);
});

test('the summary counts rows and flags unmatched ledger rows and duplicate links', () => {
  const s = reconcile(entra, ledger).summary;
  assert.equal(s.entraUsers, 3); assert.equal(s.ledgerRows, 4); assert.equal(s.linked, 1); assert.equal(s.candidateExisting, 1); assert.equal(s.missing, 1);
  assert.equal(s.ledgerRowsNotMatchedByAnyListedUser, 2, 'rows 2 and 4 match nobody in the list');
  assert.equal(s.ledgerRowsWithEntraObjectId, 1); assert.equal(s.ledgerRowsWithEmail, 3, 'rows 1, 3 and 4 have an e-mail'); assert.equal(s.ledgerRowsWithCategory, 2);
  const dup = reconcile(entra, [...ledger, { id: '5', fields: { Title: '別行', EntraObjectId: OID_A } }]).summary;
  assert.equal(dup.duplicateEntraObjectIdsInLedger, 1);
});

test('no ledger value (e-mail, category, ledger name) appears in the output', () => {
  const text = JSON.stringify(reconcile(entra, ledger));
  for (const secret of ['noguchi.private@gmail.com', 'test@example.com', '一般社員', 'アルバイト', 'テスト太郎', '橋中']) assert.ok(!text.includes(secret), `leaked: ${secret}`);
});

test('missing or malformed input does not throw', () => {
  const r = reconcile(undefined, null);
  assert.deepEqual(r.results, []); assert.equal(r.summary.ledgerRows, 0);
  const noOid = reconcile([{ displayName: 'X', userPrincipalName: 'x@e.com' }], [{ id: '9', fields: { EntraObjectId: '' } }]).results[0];
  assert.equal(noOid.objectIdKnown, false); assert.equal(noOid.matchedByObjectId, false, 'an empty objectId never matches an empty ledger cell');
});
