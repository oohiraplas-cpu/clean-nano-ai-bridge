const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { findPythonInterpreter } = require('./helpers/pythonInterpreter');
const yaml = require('js-yaml');
const workflow = yaml.load(fs.readFileSync('.github/workflows/cn-aiiraidaicho-backup-manual.yml', 'utf8'));
const step = workflow.jobs['export-backup'].steps.find(x => x.name.startsWith('Extract isolated'));
// Production (GitHub Actions ubuntu-latest) runs this step on Linux, where os.sep is
// already '/' and zipfile never rewrites a stored backslash entry on read. On Windows,
// CPython's zipfile rebuilds every ZipInfo from the central directory via ZipInfo(name)
// when reading (see zipfile._RealGetContents), which re-applies os.sep normalization on
// *read* regardless of what bytes are actually in the archive - so an exact Windows-style
// entry would be seen as forward-slash even though the fixture above wrote the literal
// backslash. Patching os.sep before running the extracted script makes it exercise the
// real production (Linux) zipfile-read behavior on every host OS; it is a no-op on Linux.
const script = "import os as _os; _os.sep = '/'\n" + step.run.split("python3 - <<'PY'\n")[1].replace(/\nPY\s*$/, '');
const python = findPythonInterpreter();
if (!python) throw new Error('No usable Python 3 interpreter found for backup manifest tests');

for (const [label, entries, success] of [
  ['Windows entries', ['Src\\S1_Home.pa.yaml'], true],
  ['POSIX entries', ['Src/S1_Home.pa.yaml'], true],
  ['ambiguous basenames', ['Src/S1_Home.pa.yaml', 'Src\\S1_Home.pa.yaml'], false],
  ['traversal', ['Src/../S1_Home.pa.yaml'], false]
]) test(`backup manifest observes exact ${label}`, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-manifest-test-'));
  try {
    // zipfile.ZipInfo(str) normalizes os.sep to '/' in its constructor (so a plain
    // writestr(name, ...) on Windows would silently turn 'Src\\S1_Home.pa.yaml' into
    // 'Src/S1_Home.pa.yaml' before the fixture is even written). Build the ZipInfo with a
    // placeholder name, then overwrite .filename directly - plain attribute assignment skips
    // that normalization - so the fixture holds the exact literal entry on every host OS.
    const setup = `import io,json,zipfile,pathlib\nentries=json.loads(${JSON.stringify(JSON.stringify(entries))})\napp=io.BytesIO()\nwith zipfile.ZipFile(app,'w') as z:\n z.writestr('Properties.json',json.dumps({'Name':'clean nano kk'}))\n for name in entries:\n  info=zipfile.ZipInfo('x')\n  info.filename=name\n  z.writestr(info,'Screens: {}')\npathlib.Path('out').mkdir()\nwith zipfile.ZipFile('out/CN_AIIraiDaicho-unmanaged.zip','w') as z:\n z.writestr('solution.xml','<UniqueName>CN_AIIraiDaicho</UniqueName>')\n z.writestr('customizations.xml','')\n z.writestr('[Content_Types].xml','')\n z.writestr('CanvasApps/fixture.msapp',app.getvalue())\n`;
    assert.equal(spawnSync(python.command, [...python.args, '-c', setup], { cwd: dir }).status, 0);
    const result = spawnSync(python.command, [...python.args, '-c', script], { cwd: dir });
    assert.equal(result.status === 0, success);
    if (success) {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'out/CN_AIiraidaicho_source/source-manifest.json')));
      assert.equal(manifest.observedArchiveEntries['S1_Home.pa.yaml'], entries[0]);
      assert.equal(manifest.appIdParityVerified, false);
      assert.equal(manifest.savedSourceComparisonVerified, false);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
