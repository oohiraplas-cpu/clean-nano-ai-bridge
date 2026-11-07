'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOperationsMcp } = require('../src/operationsMcp');
const { PUBLISHED_TOOLS, MCP_PUBLIC_TOOLS } = require('../src/server');
const { resolveVisibleCall, FACADES } = require('../src/toolVisibility');
const { createZip } = require('../src/files/zipSafe');
const { createFileOps } = require('../src/files/fileOps');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-work-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-outside-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, 'a.txt'), 'line1\nline2\n');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'b.json'), '{"k":1}');
  fs.writeFileSync(path.join(outside, 'secret-outside.txt'), 'outside');
  // Junctions exercise the same reparse-point escape guard without requiring
  // Windows developer mode or elevated symbolic-link privileges.
  fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(process.platform === 'win32' ? outside : path.join(outside, 'secret-outside.txt'),
    path.join(root, 'link.txt'), process.platform === 'win32' ? 'junction' : 'file');
  return { root, outside };
}

const mcpFor = (root) => createOperationsMcp({ files: { workRoot: root } }, { store: undefined });
const ok = (p) => assert.equal(p.status, 'PASS', JSON.stringify(p));

test('file_op: 一覧・階層・検索・メタ情報・ハッシュは作業ルート内だけで動く', async (t) => {
  const { root } = workspace(t);
  const m = mcpFor(root);
  const list = await m.callTool('files_manage', { operation: 'directory_list', path: '.' });
  ok(list);
  assert.deepEqual(list.entries.map((e) => e.name), ['a.txt', 'escape', 'link.txt', 'sub']);
  assert.equal(list.entries.find((e) => e.name === 'escape').kind, 'symlink');
  const tree = await m.callTool('files_manage', { operation: 'folder_tree', maxDepth: 2 });
  ok(tree);
  assert.ok(tree.nodes.some((n) => n.path === 'sub/b.json'));
  const found = await m.callTool('files_manage', { operation: 'file_search', pattern: 'B.JSON' });
  ok(found);
  assert.deepEqual(found.matches.map((x) => x.path), ['sub/b.json']);
  const meta = await m.callTool('files_manage', { operation: 'file_metadata_get', path: 'a.txt' });
  ok(meta);
  assert.equal(meta.kind, 'file');
  assert.match(meta.sha256, /^[a-f0-9]{64}$/);
  const hash = await m.callTool('files_manage', { operation: 'hash_sha256', path: 'a.txt' });
  assert.equal(hash.sha256, meta.sha256);
});

test('file_op: 読取は文字列を返し、秘密値らしき内容は伏せ字にする', async (t) => {
  const { root } = workspace(t);
  fs.writeFileSync(path.join(root, 'cfg.txt'), 'Password=dummy-value-9999\nok');
  const read = await mcpFor(root).callTool('files_manage', { operation: 'file_read', path: 'cfg.txt' });
  ok(read);
  assert.equal(read.secretsMasked, true);
  assert.equal(read.content.includes('dummy-value-9999'), false);
});

test('file_op: 絶対パス・..・シンボリックリンク経由の脱出・予約領域は拒否する', async (t) => {
  const { root, outside } = workspace(t);
  const m = mcpFor(root);
  for (const p of ['/etc/passwd', '../x', 'escape/secret-outside.txt', 'link.txt', '.cn-snapshots/x']) {
    const r = await m.callTool('files_manage', { operation: 'file_read', path: p });
    assert.equal(r.status, 'FAIL', p);
    assert.ok(['PATH_ABSOLUTE', 'PATH_TRAVERSAL', 'SYMLINK_ESCAPE', 'SYMLINK_REFUSED', 'PATH_RESERVED'].includes(r.reasonCode), `${p} ${r.reasonCode}`);
    assert.equal(r.content, undefined);
  }
  assert.equal(fs.readFileSync(path.join(outside, 'secret-outside.txt'), 'utf8'), 'outside');
});

test('file_op: 書込みは既定で dryRun、上書きは明示時のみ、上書き前にスナップショットを残す', async (t) => {
  const { root } = workspace(t);
  const m = mcpFor(root);
  const refusedPlan = await m.callTool('files_manage', { operation: 'file_write', path: 'a.txt', content: 'changed' });
  assert.equal(refusedPlan.reasonCode, 'TARGET_EXISTS', '上書き不可の計画は作成前に拒否する');
  const plan = await m.callTool('files_manage', { operation: 'file_write', path: 'a.txt', content: 'changed', overwrite: true });
  ok(plan);
  assert.equal(plan.executed, false);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.rollbackAvailable, true);
  assert.equal(plan.plan.action, 'overwrite');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'line1\nline2\n');
  const refused = await m.callTool('files_manage', { operation: 'file_write', path: 'a.txt', content: 'x', dryRun: false });
  assert.equal(refused.reasonCode, 'TARGET_EXISTS');
  const done = await m.callTool('files_manage', { operation: 'file_write', path: 'a.txt', content: 'changed', dryRun: false, overwrite: true });
  ok(done);
  assert.equal(done.executed, true);
  assert.equal(done.verified, true);
  assert.equal(done.rollbackAvailable, true);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'changed');
  const snap = path.join(root, '.cn-snapshots', done.snapshotId, 'a.txt');
  assert.equal(fs.readFileSync(snap, 'utf8'), 'line1\nline2\n');
});

test('file_op: 新規作成は取消しを自動削除せず手動案内を返す', async (t) => {
  const { root } = workspace(t);
  const r = await mcpFor(root).callTool('files_manage', { operation: 'file_write', path: 'new/c.txt', content: 'hi', dryRun: false });
  ok(r);
  assert.equal(r.rollbackAvailable, false);
  assert.equal(r.rollbackMethod, 'manual_delete');
  assert.equal(fs.readFileSync(path.join(root, 'new', 'c.txt'), 'utf8'), 'hi');
});

test('file_op: 秘密値らしき内容の書込みは拒否し、内容を返さない', async (t) => {
  const { root } = workspace(t);
  const r = await mcpFor(root).callTool('files_manage', { operation: 'file_write', path: 'x.txt', content: 'Password=dummy-value-7777', dryRun: false });
  assert.equal(r.reasonCode, 'SECRET_DETECTED');
  assert.equal(JSON.stringify(r).includes('dummy-value-7777'), false);
  assert.equal(fs.existsSync(path.join(root, 'x.txt')), false);
});

test('file_op: コピーは既存を上書きせず、差分と SHA-256 を返す', async (t) => {
  const { root } = workspace(t);
  const m = mcpFor(root);
  const copy = await m.callTool('files_manage', { operation: 'file_copy', source: 'a.txt', destination: 'copy.txt', dryRun: false });
  ok(copy);
  assert.equal(fs.readFileSync(path.join(root, 'copy.txt'), 'utf8'), 'line1\nline2\n');
  const again = await m.callTool('files_manage', { operation: 'file_copy', source: 'a.txt', destination: 'copy.txt', dryRun: false });
  assert.equal(again.reasonCode, 'TARGET_EXISTS');
  fs.writeFileSync(path.join(root, 'b2.txt'), 'line1\nchanged\nextra\n');
  const diff = await m.callTool('files_manage', { operation: 'file_diff', left: 'a.txt', right: 'b2.txt' });
  ok(diff);
  assert.equal(diff.identical, false);
  assert.equal(diff.removed, 1);
  assert.equal(diff.added, 2);
  assert.equal(diff.unchanged, 2);
});

test('file_op: バイナリは読取・比較しない', async (t) => {
  const { root } = workspace(t);
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
  const read = await mcpFor(root).callTool('files_manage', { operation: 'file_read', path: 'bin.dat' });
  ok(read);
  assert.equal(read.binary, true);
  assert.equal(read.content, null);
  const diff = await mcpFor(root).callTool('files_manage', { operation: 'file_diff', left: 'bin.dat', right: 'a.txt' });
  assert.equal(diff.reasonCode, 'BINARY_FILE');
});

test('file_op: 作業ルート未設定は BLOCKED（ダミー成功にしない）', async () => {
  const r = await createOperationsMcp({}).callTool('files_manage', { operation: 'directory_list' });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.reasonCode, 'ADAPTER_NOT_CONFIGURED');
});

test('file_op: action ごとの入力スキーマに合わない値は VALIDATION_FAILED', async (t) => {
  const { root } = workspace(t);
  const m = mcpFor(root);
  const bad = [
    { operation: 'file_read' },
    { operation: 'file_read', path: 'a.txt', extra: 1 },
    { operation: 'directory_list', maxEntries: 99999 },
    { operation: 'file_write', path: 'a.txt', content: 5 },
    { operation: 'file_search', pattern: '' }
  ];
  for (const args of bad) {
    const r = await m.callTool('files_manage', args);
    assert.equal(r.status, 'FAIL', JSON.stringify(args));
    assert.equal(r.reasonCode, 'VALIDATION_FAILED', JSON.stringify(args));
  }
});

test('file_op: 公開 facade は未知の action を VALIDATION_FAILED で拒否する', () => {
  assert.throws(() => resolveVisibleCall('file_op', { operation: 'file_delete', path: 'a.txt' }), (e) => {
    assert.equal(e.payload.reasonCode, 'VALIDATION_FAILED');
    return true;
  });
  const resolved = resolveVisibleCall('file_op', { operation: 'file_read', path: 'a.txt' });
  assert.equal(resolved.name, 'files_manage');
  assert.equal(resolved.args.operation, 'file_read');
});

test('zip_op: 検査・検証・展開（dryRun 既定）・作成が安全に動き、元ZIPは変わらない', async (t) => {
  const { root } = workspace(t);
  const m = mcpFor(root);
  fs.writeFileSync(path.join(root, 'pack.zip'), createZip([{ name: 'docs/readme.txt', data: 'hello' }]));
  const before = fs.readFileSync(path.join(root, 'pack.zip'));
  const inspect = await m.callTool('zip_manage', { operation: 'zip_inspect', path: 'pack.zip' });
  ok(inspect);
  assert.equal(inspect.zipValid, true);
  assert.equal(inspect.entryCount, 1);
  const plan = await m.callTool('zip_manage', { operation: 'zip_extract', path: 'pack.zip', destination: 'out' });
  ok(plan);
  assert.equal(plan.executed, false);
  assert.equal(fs.existsSync(path.join(root, 'out')), false);
  const done = await m.callTool('zip_manage', { operation: 'zip_extract', path: 'pack.zip', destination: 'out', dryRun: false });
  ok(done);
  assert.equal(done.sourceUnchanged, true);
  assert.equal(fs.readFileSync(path.join(root, 'out', 'docs', 'readme.txt'), 'utf8'), 'hello');
  assert.deepEqual(fs.readFileSync(path.join(root, 'pack.zip')), before);
  const created = await m.callTool('zip_manage', { operation: 'zip_create', destination: 'made.zip', sources: ['a.txt', 'sub/b.json'], dryRun: false });
  ok(created);
  assert.equal(created.verified, true);
  assert.deepEqual(created.plan.entries.map((entry) => entry.name), ['a.txt', 'sub/b.json']);
  const made = await m.callTool('zip_manage', { operation: 'zip_inspect', path: 'made.zip' });
  ok(made);
  assert.deepEqual(made.entries.map((entry) => entry.name), ['a.txt', 'sub/b.json']);
  const again = await m.callTool('zip_manage', { operation: 'zip_create', destination: 'made.zip', sources: ['a.txt'], dryRun: false });
  assert.equal(again.reasonCode, 'TARGET_EXISTS');
  const val = await m.callTool('zip_manage', { operation: 'zip_validate', path: 'made.zip' });
  ok(val);
});

test('zip_op: ZIP Slip・symlink・重複名・実行ファイルを含むZIPは展開しない', async (t) => {
  const { root } = workspace(t);
  const m = mcpFor(root);
  const slip = Buffer.from(createZip([{ name: 'ok.txt', data: 'a' }]));
  // 不正な名前は作成関数では作れないため、名前を書き換えて作る（テスト専用）。
  // 同じ長さ（12バイト）の名前に置換し、ローカルヘッダと中央ディレクトリの両方を書き換える。
  const evil = Buffer.from(createZip([{ name: 'xxxxxxxx.txt', data: 'x' }]).toString('latin1').split('xxxxxxxx.txt').join('../../etc.xt'), 'latin1');
  fs.writeFileSync(path.join(root, 'evil.zip'), evil);
  const r1 = await m.callTool('zip_manage', { operation: 'zip_validate', path: 'evil.zip' });
  assert.equal(r1.status, 'FAIL');
  assert.ok(r1.violations.some((v) => v.code === 'ZIP_SLIP'));
  const r2 = await m.callTool('zip_manage', { operation: 'zip_extract', path: 'evil.zip', destination: 'out2', dryRun: false });
  assert.equal(r2.status, 'FAIL');
  assert.equal(fs.existsSync(path.join(root, 'out2')), false);
  fs.writeFileSync(path.join(root, 'ok.zip'), slip);
  const r3 = await m.callTool('zip_manage', { operation: 'zip_validate', path: 'ok.zip' });
  assert.equal(r3.status, 'PASS');
});

test('zip_op: 壊れたZIP・ディレクトリ指定・未知action', async (t) => {
  const { root } = workspace(t);
  const m = mcpFor(root);
  fs.writeFileSync(path.join(root, 'bad.zip'), 'not a zip');
  const r = await m.callTool('zip_manage', { operation: 'zip_inspect', path: 'bad.zip' });
  assert.equal(r.status, 'FAIL');
  const d = await m.callTool('zip_manage', { operation: 'zip_inspect', path: 'sub' });
  assert.equal(d.reasonCode, 'NOT_A_FILE');
  const u = await m.callTool('zip_manage', { operation: 'zip_delete', path: 'bad.zip' });
  assert.equal(u.reasonCode, 'VALIDATION_FAILED');
});

test('structured_data_op: JSON / YAML / XML の整形式を検証し、DTD を拒否する', async (t) => {
  const { root } = workspace(t);
  const m = mcpFor(root);
  ok(await m.callTool('structured_data_manage', { operation: 'json_validate', path: 'sub/b.json' }));
  const badJson = await m.callTool('structured_data_manage', { operation: 'json_validate', content: '{"a":' });
  assert.equal(badJson.reasonCode, 'INVALID_DOCUMENT');
  assert.ok(badJson.errors.length >= 1);
  ok(await m.callTool('structured_data_manage', { operation: 'yaml_validate', content: 'a: 1\nb: [1, 2]' }));
  const badYaml = await m.callTool('structured_data_manage', { operation: 'yaml_validate', content: 'a: [1' });
  assert.equal(badYaml.valid, false);
  ok(await m.callTool('structured_data_manage', { operation: 'xml_validate', content: '<?xml version="1.0"?><a x="1"><b>t &amp; u</b><c/></a>' }));
  const xxe = await m.callTool('structured_data_manage', { operation: 'xml_validate', content: '<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>' });
  assert.equal(xxe.errors[0].code, 'XML_DTD_FORBIDDEN');
  const mismatch = await m.callTool('structured_data_manage', { operation: 'xml_validate', content: '<a><b></a>' });
  assert.equal(mismatch.valid, false);
  const both = await m.callTool('structured_data_manage', { operation: 'json_validate', path: 'a.txt', content: '{}' });
  assert.equal(both.reasonCode, 'VALIDATION_FAILED');
});

test('公開一覧: 3 facade が追加され、内部ツールは公開されず、公開数は 70 未満', () => {
  const names = PUBLISHED_TOOLS.map((t) => t.name);
  for (const n of ['file_op', 'zip_op', 'structured_data_op']) assert.ok(names.includes(n), n);
  for (const n of ['files_manage', 'zip_manage', 'structured_data_manage']) assert.equal(names.includes(n), false, n);
  assert.ok(MCP_PUBLIC_TOOLS.some((t) => t.name === 'files_manage'));
  assert.ok(PUBLISHED_TOOLS.length < 70, String(PUBLISHED_TOOLS.length));
  assert.equal(new Set(names).size, names.length);
});

test('facade の説明は利用可能 action を日本語で列挙する', () => {
  for (const name of ['file_op', 'zip_op', 'structured_data_op']) {
    const f = FACADES.find((x) => x.name === name);
    for (const action of Object.keys(f.ops)) assert.ok(f.description.includes(action), `${name} ${action}`);
  }
});

test('createFileOps は作業ルートが存在しない場合 BLOCKED を返す', async () => {
  const ops = createFileOps({ workRoot: path.join(os.tmpdir(), 'cn-missing-' + Date.now()) });
  const r = await ops.run('directory_list', {});
  assert.equal(r.status, 'BLOCKED');
});
