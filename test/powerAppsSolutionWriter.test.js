'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { readZip, writeZip } = require('../src/zipLite');
const w = require('../src/powerAppsSolutionWriter');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5d90000000049454e44ae426082', 'hex');

function makeSolution() {
  const resources = { Resources: [{ Name: 'logo', Schema: 'i', FileName: 'logo.png', Path: 'Assets\\Images\\abc.png', Content: 'Image', IsSampleData: false, IsWritable: false, Type: 'ResourceInfo', ResourceKind: 'LocalFile' }] };
  const msapp = writeZip([
    { name: 'Controls\\4.json', data: Buffer.from('{"Rules":[{"Property":"Fill","InvariantScript":"RGBA(6, 18, 10, 1) // cn-verify"}]}') },
    { name: 'Src\\MainScreen1.pa.yaml', data: Buffer.from('Fill: =RGBA(6, 18, 10, 1) // cn-verify\nTitle: ="日報"\n') },
    { name: 'References\\Resources.json', data: Buffer.from(JSON.stringify(resources)) },
    { name: 'Assets\\Images\\abc.png', data: Buffer.from('old') },
  ]);
  return writeZip([
    { name: 'solution.xml', data: Buffer.from('<x/>') },
    { name: 'CanvasApps/cr296_app_DocumentUri.msapp', data: msapp },
  ]);
}

function fakeClient() {
  const st = { buf: makeSolution(), imports: 0, publishes: 0 };
  return { st, client: {
    exportSolution: async () => st.buf,
    importSolution: async (b) => { st.buf = b; st.imports++; return 'job-1'; },
    publishAll: async () => { st.publishes++; },
  } };
}

const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnsnap-'));

test('zip round trip preserves backslash and utf8 names', () => {
  const z = writeZip([{ name: 'A\\b.json', data: Buffer.from('x') }, { name: 'Src/日報.yaml', data: Buffer.from('y') }]);
  const r = readZip(z);
  assert.deepStrictEqual(r.map((e) => e.name), ['A\\b.json', 'Src/日報.yaml']);
  assert.strictEqual(r[1].data.toString(), 'y');
});

test('applyEdit edits, imports, publishes and verifies', async () => {
  const { st, client } = fakeClient();
  const r = await w.applyEdit({ solutionName: 'S', edits: [{ find: ' // cn-verify', replace: '' }, { find: '="日報"', replace: '="日報アプリ"' }] }, { client, snapshotDir });
  assert.strictEqual(r.status, 'published_verified');
  assert.strictEqual(r.edits[0].matches, 2);
  assert.strictEqual(st.imports, 1); assert.strictEqual(st.publishes, 1);
  const inner = readZip(readZip(st.buf)[1].data);
  assert.ok(inner.every((e) => !e.data.toString().includes('cn-verify')));
  assert.ok(inner.some((e) => e.name === 'Src\\MainScreen1.pa.yaml'));
  assert.ok(fs.existsSync(path.join(snapshotDir, `${r.snapshotId}.zip`)));
});

test('applyEdit refuses when find text is missing and imports nothing', async () => {
  const { st, client } = fakeClient();
  await assert.rejects(w.applyEdit({ solutionName: 'S', edits: [{ find: 'NOPE', replace: 'x' }] }, { client, snapshotDir }), /not found/);
  assert.strictEqual(st.imports, 0);
});

test('expectCount mismatch blocks', async () => {
  const { st, client } = fakeClient();
  await assert.rejects(w.applyEdit({ solutionName: 'S', edits: [{ find: 'cn-verify', replace: 'z', expectCount: 1 }] }, { client, snapshotDir }), /expected 1/);
  assert.strictEqual(st.imports, 0);
});

test('image replace and add', async () => {
  const { st, client } = fakeClient();
  const r = await w.applyEdit({ solutionName: 'S', images: [{ name: 'logo', base64: PNG.toString('base64') }, { name: 'HomeHero', base64: 'data:image/png;base64,' + PNG.toString('base64') }] }, { client, snapshotDir });
  assert.strictEqual(r.status, 'published_verified');
  assert.deepStrictEqual(r.images.map((i) => i.action), ['replaced', 'added']);
  const inner = readZip(readZip(st.buf)[1].data);
  const res = JSON.parse(inner.find((e) => e.name.endsWith('Resources.json')).data.toString());
  assert.strictEqual(res.Resources.length, 2);
  assert.strictEqual(res.Resources[1].Name, 'HomeHero');
  assert.ok(inner.find((e) => e.name === 'Assets\\Images\\abc.png').data.equals(PNG));
});

test('dryRun does not import', async () => {
  const { st, client } = fakeClient();
  const r = await w.applyEdit({ solutionName: 'S', edits: [{ find: 'cn-verify', replace: 'ok' }], dryRun: true }, { client, snapshotDir });
  assert.strictEqual(r.status, 'dry_run'); assert.strictEqual(st.imports, 0);
});

test('readApp search and rollback', async () => {
  const { st, client } = fakeClient();
  const s = await w.readApp({ solutionName: 'S', search: 'Fill' }, { client });
  assert.strictEqual(s.matches.length, 2);
  const f = await w.readApp({ solutionName: 'S', file: 'Src/MainScreen1.pa.yaml' }, { client });
  assert.match(f.content, /cn-verify/);
  const r = await w.applyEdit({ solutionName: 'S', edits: [{ find: 'cn-verify', replace: 'changed' }] }, { client, snapshotDir });
  await w.rollback({ snapshotId: r.snapshotId }, { client, snapshotDir });
  assert.match(readZip(readZip(st.buf)[1].data)[0].data.toString(), /cn-verify/);
  assert.ok(w.listSnapshots({ snapshotDir }).snapshots.includes(r.snapshotId));
});
