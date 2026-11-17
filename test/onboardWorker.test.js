'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { onboardWorker } = require('../src/onboardWorker');

const OID = '99999999-9999-9999-9999-999999999999';

// A scripted fake Bridge. `calls` records every request so the tests can prove what was (not) written.
function fakeBridge({ ledgerItems = [], entraUsers = [], createResult, ledgerCreate, ledgerHasMore = false, userGet } = {}) {
  const calls = [];
  const call = async (tool, args) => {
    calls.push({ tool, args });
    if (tool === 'sharepoint_manage' && args.operation === 'search') return { ok: true, inner: { items: ledgerItems, hasMore: ledgerHasMore }, error: null };
    if (tool === 'graph_manage' && args.operation === 'user_search') return { ok: true, inner: { users: entraUsers }, error: null };
    if (tool === 'graph_manage' && args.operation === 'user_create') return createResult || { ok: true, inner: { created: true, welcomeMail: { accepted: true }, user: { id: OID, userPrincipalName: 'taro.yamada@example.onmicrosoft.com', accountEnabled: false } }, error: null };
    if (tool === 'sharepoint_manage' && args.operation === 'item_create') return ledgerCreate || { ok: true, inner: { itemId: '42', fields: { EntraObjectId: OID } }, error: null };
    if (tool === 'graph_manage' && args.operation === 'user_get') return userGet || { ok: true, inner: { accountEnabled: false, assignedLicenses: [] }, error: null };
    return { ok: false, inner: null, error: 'unexpected call' };
  };
  const writes = () => calls.filter((c) => (c.tool === 'graph_manage' && c.args.operation === 'user_create') || (c.tool === 'sharepoint_manage' && c.args.operation === 'item_create'));
  return { call, calls, writes };
}
const PERSON = { displayName: '山田 太郎', email: 'taro.yamada@gmail.com' };

test('input is validated before anything is called', async () => {
  const b = fakeBridge();
  assert.equal((await onboardWorker({ displayName: '', email: 'a@b.co' }, b.call)).status, 'invalid_input');
  assert.equal((await onboardWorker({ displayName: 'X', email: 'not-an-email' }, b.call)).status, 'invalid_input');
  assert.equal(b.calls.length, 0);
});

test('dry run (the default) checks duplicates and prints the plan, and writes nothing', async () => {
  const b = fakeBridge();
  const r = await onboardWorker(PERSON, b.call);
  assert.equal(r.status, 'dry_run_ok'); assert.equal(r.changed, false);
  assert.equal(b.writes().length, 0);
  assert.equal(r.plan.entraAccount.accountEnabled, false, 'the account is planned disabled by default');
  assert.match(r.plan.ledgerRow.EmployeeCategory, /初回サインイン/);
});

test('a ledger or Entra match stops the run: nothing is created, even when dryRun is false', async () => {
  for (const [label, opts, expected] of [
    ['ledger name (spacing differs)', { ledgerItems: [{ id: '1', fields: { Title: '山田太郎' } }] }, 'ledger_name'],
    ['ledger e-mail', { ledgerItems: [{ id: '1', fields: { Title: '別人', EmailAddress: 'Taro.Yamada@gmail.com' } }] }, 'ledger_email'],
    ['entra name', { entraUsers: [{ displayName: '山田　太郎', userPrincipalName: 'x@e.com', mail: null }] }, 'entra_name'],
    ['entra e-mail', { entraUsers: [{ displayName: '誰か', userPrincipalName: 'q@e.com', mail: 'taro.yamada@gmail.com' }] }, 'entra_email'],
  ]) {
    const b = fakeBridge(opts);
    const r = await onboardWorker(PERSON, b.call, { dryRun: false });
    assert.equal(r.status, 'duplicate_found', label); assert.ok(r.matches.includes(expected), label); assert.equal(r.changed, false);
    assert.equal(b.writes().length, 0, `${label}: no write`);
  }
});

test('a check that cannot be completed stops the run (fail closed)', async () => {
  const more = fakeBridge({ ledgerHasMore: true });
  assert.equal((await onboardWorker(PERSON, more.call, { dryRun: false })).status, 'check_failed');
  assert.equal(more.writes().length, 0);
  const failing = async (tool, args) => (tool === 'graph_manage' ? { ok: false, inner: null, error: 'boom' } : { ok: true, inner: { items: [], hasMore: false }, error: null });
  assert.equal((await onboardWorker(PERSON, failing, { dryRun: false })).status, 'check_failed');
});

test('a real run creates the account (approved, welcome mail on, disabled by default), then the ledger row, then verifies', async () => {
  const b = fakeBridge();
  const r = await onboardWorker(PERSON, b.call, { dryRun: false, approver: 'owner-chat' });
  assert.equal(r.status, 'completed'); assert.equal(r.changed, true);
  const create = b.writes()[0].args;
  assert.equal(create.operation, 'user_create'); assert.equal(create.approvedByHuman, true); assert.equal(create.welcomeMail, true); assert.equal(create.approver, 'owner-chat');
  assert.equal(create.user.accountEnabled, false); assert.equal(create.user.contactEmail, PERSON.email);
  assert.ok(!('passwordProfile' in create.user), 'no password is ever supplied: the server generates it');
  const row = b.writes()[1].args;
  assert.equal(row.fields.EntraObjectId, OID); assert.equal(row.fields.EmailAddress, PERSON.email); assert.equal(row.fields.EmployeeID, '未採番');
  assert.ok(!('EmployeeCategory' in row.fields), 'the category is left for the person to choose on first sign-in');
  assert.equal(r.ledger.entraObjectIdLinked, true); assert.equal(r.ledger.categoryEmpty, true);
  assert.ok(r.nextForOwner.some((s) => s.includes('ライセンス')) && r.nextForOwner.some((s) => s.includes('有効化')));
  assert.ok(!JSON.stringify(r).toLowerCase().includes('password'), 'the report carries no password');
});

test('enableNow=true creates an enabled account and drops the enable reminder', async () => {
  const b = fakeBridge();
  const r = await onboardWorker(PERSON, b.call, { dryRun: false, enableNow: true });
  assert.equal(b.writes()[0].args.user.accountEnabled, true);
  assert.ok(!r.nextForOwner.some((s) => s.includes('有効化')));
});

test('if the account cannot be created, no ledger row is written', async () => {
  const b = fakeBridge({ createResult: { ok: false, inner: null, error: 'a user with this user principal name already exists; nothing was changed' } });
  const r = await onboardWorker(PERSON, b.call, { dryRun: false });
  assert.equal(r.status, 'create_failed'); assert.equal(r.changed, false);
  assert.equal(b.writes().filter((w) => w.args.operation === 'item_create').length, 0);
  const blocked = fakeBridge({ createResult: { ok: true, inner: { blocked: true, requiredPermissions: ['User.ReadWrite.All'] }, error: null } });
  assert.equal((await onboardWorker(PERSON, blocked.call, { dryRun: false })).status, 'create_blocked');
});

test('if the ledger row fails after the account exists, the report says so and warns against re-running', async () => {
  const b = fakeBridge({ ledgerCreate: { ok: false, inner: null, error: 'required column missing' } });
  const r = await onboardWorker(PERSON, b.call, { dryRun: false });
  assert.equal(r.status, 'created_but_ledger_failed'); assert.equal(r.changed, true); assert.equal(r.entra.objectId, OID);
  assert.match(r.next, /再実行しないで/);
});
