const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const workflow = yaml.load(fs.readFileSync('.github/workflows/cn-aiiraidaicho-backup-manual.yml', 'utf8'));
const step = workflow.jobs['export-backup'].steps.find(x => x.name.startsWith('Extract isolated'));
const script = step.run.split("python3 - <<'PY'\n")[1].replace(/\nPY\s*$/, '');

for (const [label, entries, success] of [
  ['Windows entries', ['Src\\S1_Home.pa.yaml'], true],
  ['POSIX entries', ['Src/S1_Home.pa.yaml'], true],
  ['ambiguous basenames', ['Src/S1_Home.pa.yaml', 'Src\\S1_Home.pa.yaml'], false],
  ['traversal', ['Src/../S1_Home.pa.yaml'], false]
]) test(`backup manifest observes exact ${label}`, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-manifest-test-'));
  try {
    const setup = `import io,json,zipfile,pathlib\nentries=json.loads(${JSON.stringify(JSON.stringify(entries))})\napp=io.BytesIO()\nwith zipfile.ZipFile(app,'w') as z:\n z.writestr('Properties.json',json.dumps({'Name':'CN_AI依頼台帳'}))\n for name in entries: z.writestr(name,'Screens: {}')\npathlib.Path('out').mkdir()\nwith zipfile.ZipFile('out/CN_AIIraiDaicho-unmanaged.zip','w') as z:\n z.writestr('solution.xml','<UniqueName>CN_AIIraiDaicho</UniqueName>')\n z.writestr('customizations.xml','')\n z.writestr('[Content_Types].xml','')\n z.writestr('CanvasApps/fixture.msapp',app.getvalue())\n`;
    assert.equal(spawnSync('python3', ['-c', setup], { cwd: dir }).status, 0);
    const result = spawnSync('python3', ['-c', script], { cwd: dir });
    assert.equal(result.status === 0, success);
    if (success) {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'out/CN_AIiraidaicho_source/source-manifest.json')));
      assert.equal(manifest.observedArchiveEntries['S1_Home.pa.yaml'], entries[0]);
      assert.equal(manifest.appIdParityVerified, false);
      assert.equal(manifest.savedSourceComparisonVerified, false);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
