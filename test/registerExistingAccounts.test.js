'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerExisting, plan } = require('../src/registerExistingAccounts');

const O = { noguchi: 'aaaaaaaa-0000-0000-0000-000000000001', yamada: 'aaaaaaaa-0000-0000-0000-000000000002', hashinaka: 'aaaaaaaa-0000-0000-0000-000000000003', niihira: 'aaaaaaaa-0000-0000-0000-000000000004', other: 'aaaaaaaa-0000-0000-0000-000000000009' };
const USERS = [
  { objectId: O.noguchi, displayName: '野口 英光', userPrincipalName: 's63@e.onmicrosoft.com' },
  { objectId: O.yamada, displayName: '山田 悠弥', userPrincipalName: '001@e.onmicrosoft.com' },
  { objectId: O.hashinaka, displayName: '箸中 雄也', userPrincipalName: 'yuya@e.onmicrosoft.com' },
  { objectId: O.niihira, displayName: '仁平 蒼志', userPrincipalName: 'soushi@e.onmicrosoft.com' },
];
const LEDGER = [
  { id: '1', fields: { Title: '野口英光', EntraObjectId: '', EmailAddress: 'private@gmail.com', EmployeeCategory: '一般社員' } },
  { id: '2', fields: { Title: '山田 悠弥', EntraObjectId: '' } },
  { id: '3', fields: { Title: 'テスト', EntraObjectId: O.other } },
];
const UPNS = ['s63@e.onmicrosoft.com', '001@e.onmicrosoft.com', 'yuya@e.onmicrosoft.com', 'soushi@e.onmicrosoft.com'];

test('plan: link the single same-name row with an empty id, create the missing ones', () => {
  const a = plan(UPNS, USERS, LEDGER);
  assert.deepEqual(a.map((x) => x.action), ['link', 'link', 'create', 'create']);
  assert.equal(a[0].rowId, '1'); assert.equal(a[1].rowId, '2');
});

test('plan: a row already holding this id is skipped (idempotent)', () => {
  const ledger = [{ id: '1', fields: { Title: '野口英光', EntraObjectId: O.noguchi } }];
  assert.equal(plan(['s63@e.onmicrosoft.com'], USERS, ledger)[0].action, 'skip_linked');
});

test('plan: ambiguity is a conflict, never a write', () => {
  const twoRows = [{ id: '1', fields: { Title: '野口英光' } }, { id: '2', fields: { Title: '野口 英光' } }];
  assert.equal(plan(['s63@e.onmicrosoft.com'], USERS, twoRows)[0].action, 'conflict');
  const otherId = [{ id: '1', fields: { Title: '野口英光', EntraObjectId: O.other } }];
  const c = plan(['s63@e.onmicrosoft.com'], USERS, otherId)[0];
  assert.equal(c.action, 'conflict'); assert.match(c.reason, /別のオブジェクト ID/);
  assert.equal(plan(['s63@e.onmicrosoft.com', 'S63@E.onmicrosoft.com'], USERS, [])[1].action, 'conflict', 'the same account twice in the targets');
});

test('plan: an unknown UPN is not_found, and a different kanji spelling is NOT treated as the same person', () => {
  assert.equal(plan(['nobody@e.onmicrosoft.com'], USERS, LEDGER)[0].action, 'not_found');
  const ledger = [{ id: '1', fields: { Title: '橋中 雄也' } }];
  assert.equal(plan(['yuya@e.onmicrosoft.com'], USERS, ledger)[0].action, 'create', '橋中 and 箸中 are different strings');
});

// A fake Bridge that really applies writes, so the post-write verification is meaningful.
function fakeBridge({ users = USERS, items = LEDGER, failCreateFor = null } = {}) {
  const ledger = items.map((i) => ({ id: i.id, fields: { ...i.fields } }));
  const calls = [];
  const call = async (tool, args) => {
    calls.push({ tool, args });
    if (tool === 'graph_manage') return { ok: true, inner: { users, hasMore: false }, error: null };
    if (args.operation === 'search') return { ok: true, inner: { items: ledger.map((i) => ({ id: i.id, fields: { ...i.fields } })), hasMore: false }, error: null };
    if (args.operation === 'item_update') { ledger.find((i) => i.id === args.itemId).fields.EntraObjectId = args.fields.EntraObjectId; return { ok: true, inner: { itemId: args.itemId }, error: null }; }
    if (args.operation === 'item_create') {
      if (failCreateFor && args.fields.Title === failCreateFor) return { ok: false, inner: null, error: 'boom' };
      const id = String(100 + ledger.length); ledger.push({ id, fields: { ...args.fields } }); return { ok: true, inner: { itemId: id }, error: null };
    }
    return { ok: false, inner: null, error: 'unexpected' };
  };
  const writes = () => calls.filter((c) => c.tool === 'sharepoint_manage' && ['item_update', 'item_create'].includes(c.args.operation));
  return { call, calls, writes, ledger };
}

test('dry run (the default) reports the plan and writes nothing', async () => {
  const b = fakeBridge();
  const r = await registerExisting(UPNS, b.call);
  assert.equal(r.status, 'dry_run_ok'); assert.equal(r.changed, false); assert.deepEqual(r.counts, { link: 2, create: 2 });
  assert.equal(b.writes().length, 0);
});

test('a real run links two rows, creates two, writes only the intended fields, and verifies by re-reading', async () => {
  const b = fakeBridge();
  const r = await registerExisting(UPNS, b.call, { dryRun: false });
  assert.equal(r.status, 'completed'); assert.equal(r.written, 4); assert.equal(r.verifiedAllLinked, true); assert.deepEqual(r.needsHuman, []);
  const updates = b.writes().filter((w) => w.args.operation === 'item_update');
  assert.deepEqual(updates.map((u) => Object.keys(u.args.fields)), [['EntraObjectId'], ['EntraObjectId']], 'a link writes ONLY EntraObjectId');
  const creates = b.writes().filter((w) => w.args.operation === 'item_create').map((c) => c.args.fields);
  for (const f of creates) { assert.equal(f.EmployeeID, '未採番'); assert.ok(!('EmployeeCategory' in f) && !('EmailAddress' in f), 'no category, no e-mail'); }
  assert.equal(b.ledger.length, 5, 'two new rows were added, nothing else');
});

test('re-running changes nothing (no duplicate rows)', async () => {
  const b = fakeBridge();
  await registerExisting(UPNS, b.call, { dryRun: false });
  const before = b.ledger.length;
  const again = await registerExisting(UPNS, b.call, { dryRun: false });
  assert.equal(again.written, 0); assert.equal(again.changed, false); assert.equal(b.ledger.length, before);
});

test('one failed write is reported as partial and does not hide the others', async () => {
  const b = fakeBridge({ failCreateFor: '仁平 蒼志' });
  const r = await registerExisting(UPNS, b.call, { dryRun: false });
  assert.equal(r.status, 'partial'); assert.equal(r.failed.length, 1); assert.equal(r.written, 3); assert.equal(r.verifiedAllLinked, true, 'the three that were written are linked');
});

test('checks that cannot complete stop the run before any write', async () => {
  const big = async (tool, args) => (tool === 'graph_manage' ? { ok: true, inner: { users: USERS, hasMore: true }, error: null } : { ok: true, inner: { items: [], hasMore: false }, error: null });
  assert.equal((await registerExisting(UPNS, big, { dryRun: false })).status, 'check_failed');
  const b = fakeBridge();
  assert.equal((await registerExisting([], b.call)).status, 'invalid_input');
  assert.equal((await registerExisting(Array.from({ length: 21 }, (_, i) => `u${i}@e.com`), b.call)).status, 'invalid_input');
  assert.equal(b.writes().length, 0);
});

test('the report never contains ledger values', async () => {
  const b = fakeBridge();
  const text = JSON.stringify(await registerExisting(UPNS, b.call, { dryRun: false }));
  assert.ok(!text.includes('private@gmail.com') && !text.includes('一般社員'));
});
