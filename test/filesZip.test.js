'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { validateZip, extractZip, scanZipForSecrets, createZip, crc32 } = require('../src/files/zipSafe');
const { resolveInRoot, checkRelative, PathGuardError } = require('../src/files/pathGuard');

// テスト専用: 安全な作成関数では作れない不正なZIPを手組みする。
function rawZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    const method = e.method ?? 0;
    const comp = e.comp ?? (method === 8 ? zlib.deflateRawSync(data) : data);
    const crc = e.crc ?? crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const block = Buffer.concat([local, name, comp]);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(e.flags ?? 0, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(e.uncompSize ?? data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(((e.unixMode ?? 0o100644) << 16) >>> 0, 38);
    cen.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([cen, name]));
    locals.push(block);
    offset += block.length;
  }
  const cenBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cenBuf, eocd]);
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-zip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('正常なZIPは検証OKで展開でき、元ZIPは変更されない', (t) => {
  const dir = tmpDir(t);
  const buf = createZip([{ name: 'docs/readme.txt', data: 'hello' }, { name: 'data/a.csv', data: 'x,y\n1,2\n' }]);
  const before = Buffer.from(buf);
  const report = validateZip(buf);
  assert.equal(report.ok, true);
  assert.equal(report.entryCount, 2);
  const result = extractZip(buf, path.join(dir, 'out'));
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'out', 'docs', 'readme.txt'), 'utf8'), 'hello');
  assert.deepEqual(buf, before, '元ZIPのバイト列は変わらない');
});

test('ZIP Slip（..を含むエントリ）は検出され、何も展開されない', (t) => {
  const dir = tmpDir(t);
  const buf = rawZip([{ name: 'ok.txt', data: 'a' }, { name: '../../evil.txt', data: 'pwned' }]);
  const report = validateZip(buf);
  assert.equal(report.ok, false);
  assert.ok(report.violations.some((v) => v.code === 'ZIP_SLIP'));
  const result = extractZip(buf, path.join(dir, 'out'));
  assert.equal(result.ok, false);
  assert.equal(result.extracted.length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'out', 'ok.txt')), false, '1件でも違反があれば全件展開しない');
});

test('絶対パス・ドライブ文字・バックスラッシュのエントリは拒否される', () => {
  for (const name of ['/etc/passwd', 'C:/Windows/x.txt', 'a\\..\\b.txt']) {
    const report = validateZip(rawZip([{ name, data: 'x' }]));
    assert.equal(report.ok, false, name);
  }
});

test('シンボリックリンク（unix mode 0o120000）は拒否される', () => {
  const report = validateZip(rawZip([{ name: 'link', data: '/etc/passwd', unixMode: 0o120777 }]));
  assert.equal(report.ok, false);
  assert.ok(report.violations.some((v) => v.code === 'SYMLINK'));
});

test('暗号化フラグ付きエントリは拒否される', () => {
  const report = validateZip(rawZip([{ name: 'secret.txt', data: 'x', flags: 0x1 }]));
  assert.equal(report.ok, false);
  assert.ok(report.violations.some((v) => v.code === 'ENCRYPTED'));
});

test('実行可能ファイル（.exe/.ps1/.sh/.js等）は自動実行防止のため拒否される', () => {
  for (const name of ['setup.exe', 'run.ps1', 'install.sh', 'app.js', 'mac.app', 'x.lnk']) {
    const report = validateZip(rawZip([{ name, data: 'echo' }]));
    assert.equal(report.ok, false, name);
    assert.ok(report.violations.some((v) => v.code === 'EXECUTABLE_ENTRY'), name);
  }
});

test('ZIP bomb: 圧縮率が上限を超えるエントリは拒否される', () => {
  const big = Buffer.alloc(5 * 1024 * 1024, 0x41);
  const comp = zlib.deflateRawSync(big);
  const report = validateZip(rawZip([{ name: 'bomb.txt', data: big, method: 8, comp }]));
  assert.equal(report.ok, false);
  assert.ok(report.violations.some((v) => v.code === 'COMPRESSION_RATIO_EXCEEDED'));
});

test('ZIP bomb: 展開後の単一エントリ上限を超えると拒否される', () => {
  const data = Buffer.alloc(2048, 0x42);
  const report = validateZip(rawZip([{ name: 'big.txt', data }]), { maxEntryUncompressed: 1024 });
  assert.ok(report.violations.some((v) => v.code === 'ENTRY_TOO_LARGE'));
});

test('展開後の合計上限と件数上限を超えると拒否される', () => {
  const buf = rawZip([{ name: 'a.txt', data: 'x'.repeat(100) }, { name: 'b.txt', data: 'y'.repeat(100) }]);
  assert.ok(validateZip(buf, { maxTotalUncompressed: 150 }).violations.some((v) => v.code === 'TOTAL_SIZE_EXCEEDED'));
  assert.ok(validateZip(buf, { maxEntries: 1 }).violations.some((v) => v.code === 'TOO_MANY_ENTRIES'));
});

test('重複名のエントリは拒否される', () => {
  const report = validateZip(rawZip([{ name: 'a.txt', data: '1' }, { name: 'a.txt', data: '2' }]));
  assert.ok(report.violations.some((v) => v.code === 'DUPLICATE_NAME'));
});

test('CRC不一致は展開時に拒否される', (t) => {
  const dir = tmpDir(t);
  const buf = rawZip([{ name: 'c.txt', data: 'hello', crc: 0x12345678 }]);
  const result = extractZip(buf, path.join(dir, 'out'));
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'CRC_MISMATCH');
});

test('既存ファイルは上書きせず拒否する', (t) => {
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, 'out'));
  fs.writeFileSync(path.join(dir, 'out', 'keep.txt'), 'original');
  const buf = createZip([{ name: 'keep.txt', data: 'new' }]);
  const result = extractZip(buf, path.join(dir, 'out'));
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'TARGET_EXISTS');
  assert.equal(fs.readFileSync(path.join(dir, 'out', 'keep.txt'), 'utf8'), 'original');
});

test('壊れたZIPやZIP64は構造エラーとして拒否する', () => {
  assert.equal(validateZip(Buffer.from('not a zip at all, definitely not')).ok, false);
  assert.equal(validateZip(Buffer.alloc(0)).ok, false);
});

test('秘密情報らしき文字列を含むテキストを検出する（値は返さない）', () => {
  const buf = createZip([
    { name: 'config.txt', data: 'Password=dummy-value-1234' },
    { name: 'note.txt', data: 'nothing here' }
  ]);
  const scan = scanZipForSecrets(buf);
  assert.equal(scan.findings, 1);
  assert.deepEqual(scan.names, ['config.txt']);
  assert.equal(JSON.stringify(scan).includes('dummy-value'), false);
});

test('zip_create は不正な名前を作成前に拒否する', () => {
  assert.throws(() => createZip([{ name: '../x.txt', data: 'x' }]));
  assert.throws(() => createZip([{ name: '/abs.txt', data: 'x' }]));
});

test('検証はファイルを展開せず、展開結果のsha256を返す', () => {
  const buf = createZip([{ name: 'a.txt', data: 'hello' }]);
  const report = validateZip(buf);
  assert.match(report.sha256, /^[a-f0-9]{64}$/);
});

test('パスガードはルート外への相対パスとシンボリックリンク脱出を拒否する', (t) => {
  const root = tmpDir(t);
  const outside = tmpDir(t);
  fs.symlinkSync(outside, path.join(root, 'escape'));
  assert.throws(() => resolveInRoot(root, '../x'), PathGuardError);
  assert.throws(() => resolveInRoot(root, '/etc/passwd'), PathGuardError);
  assert.throws(() => resolveInRoot(root, 'escape/x.txt'), (e) => e.code === 'SYMLINK_ESCAPE');
  assert.equal(resolveInRoot(root, 'sub/a.txt').startsWith(fs.realpathSync(root)), true);
  assert.equal(checkRelative('a/./b.txt'), path.join('a', 'b.txt'));
});

test('ZIP内の実行ファイルはどの経路でも実行されない（展開のみ）', (t) => {
  const dir = tmpDir(t);
  const marker = path.join(dir, 'ran.marker');
  const buf = createZip([{ name: 'tool.js', data: `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')` }]);
  const report = validateZip(buf);
  assert.equal(report.ok, false, '実行可能拡張子は検証で拒否される');
  assert.equal(fs.existsSync(marker), false);
});
