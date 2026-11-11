const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { runStaticTests, scanFormula } = require('../src/powerAppsStaticTests');

const screen = (name, body = '') => `Screens:\n  ${name}:\n    Properties:\n${body}`;
const file = (relativePath, content) => ({ relativePath, content });
const check = (result, id) => result.checks.find((c) => c.id === id);

test('正常なソースでも、未検証項目（Test Engine等）がある限りpassedにはならずincompleteになる', () => {
  const result = runStaticTests({ files: [file('Screen1.pa.yaml', screen('Screen1', '      Fill: =RGBA(0, 0, 0, 1)\n'))] });
  assert.equal(result.scope, 'static_analysis');
  assert.equal(check(result, 'syntax').status, 'passed');
  assert.equal(check(result, 'brackets').status, 'passed');
  assert.equal(check(result, 'quotes').status, 'passed');
  assert.equal(check(result, 'power_apps_test_engine').status, 'skipped');
  assert.ok(check(result, 'power_apps_test_engine').reason);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.summary.failed, 0);
  assert.ok(result.summary.skipped >= 1);
});

test('構文エラー（YAML・JSON）をfailedにする', () => {
  const result = runStaticTests({ files: [file('Bad.pa.yaml', 'a: [1, 2'), file('bad.json', '{broken')] });
  assert.equal(check(result, 'syntax').status, 'failed');
  assert.equal(check(result, 'syntax').findings.length, 2);
  assert.equal(result.status, 'failed');
});

test('括弧の不一致（閉じ忘れ・余分・種類違い）をfailedにする', () => {
  for (const formula of ['=If(a, 1', '=Max(1, 2))', '=Table({a, 1)']) {
    const result = runStaticTests({ files: [file('S.pa.yaml', screen('S', `      Text: ${formula}\n`))] });
    assert.equal(check(result, 'brackets').status, 'failed', formula);
    assert.equal(result.status, 'failed');
  }
});

test('文字列中の括弧・""エスケープ・コメント内の括弧は誤検出しない', () => {
  const body = [
    '      A: ="括弧( を含む文字列"',
    '      B: ="He said ""hi"" (ok)"',
    "      C: ='Screen (1)'.Fill",
    '      D: |-',
    '        =Set(x, 1); // コメントの ( は無視',
    '        Set(y, 2)'
  ].join('\n');
  const result = runStaticTests({ files: [file('S.pa.yaml', screen('S', `${body}\n`))] });
  assert.equal(check(result, 'brackets').status, 'passed');
  assert.equal(check(result, 'quotes').status, 'passed');
});

test('引用符が閉じていない式をfailedにする', () => {
  const result = runStaticTests({ files: [file('S.pa.yaml', screen('S', '      Text: ="未終了\n'))] });
  assert.equal(check(result, 'quotes').status, 'failed');
});

test('文字列補間式は走査せず、成功扱いにせずskippedにする', () => {
  const result = runStaticTests({ files: [file('S.pa.yaml', screen('S', '      Text: =$"合計 {Sum(1, 2)}"\n'))] });
  assert.equal(check(result, 'brackets').status, 'skipped');
  assert.match(check(result, 'brackets').reason, /補間/);
});

test('Power Fx式が無い場合は括弧・引用符検査をskippedにする', () => {
  const result = runStaticTests({ files: [file('m.json', '{"a": 1}')] });
  assert.equal(check(result, 'brackets').status, 'skipped');
  assert.equal(check(result, 'quotes').status, 'skipped');
});

test('画面遷移: 提供ファイル内の画面ならpassed、knownScreens指定で存在しない画面はfailed、未指定ならskipped', () => {
  const home = file('Home.pa.yaml', screen('Home', '      OnSelect: =Navigate(Screen2, ScreenTransition.Fade)\n'));
  const s2 = file('Screen2.pa.yaml', screen('Screen2'));
  assert.equal(check(runStaticTests({ files: [home, s2] }), 'screen_transitions').status, 'passed');

  const missingOnly = runStaticTests({ files: [home] });
  assert.equal(check(missingOnly, 'screen_transitions').status, 'skipped');
  assert.deepEqual(check(missingOnly, 'screen_transitions').unresolvedTargets, ['Screen2']);

  const strict = runStaticTests({ files: [home], knownScreens: ['Home', 'Screen3'] });
  assert.equal(check(strict, 'screen_transitions').status, 'failed');
  assert.match(check(strict, 'screen_transitions').findings[0].message, /Screen2/);
  assert.equal(strict.status, 'failed');

  const known = runStaticTests({ files: [home], knownScreens: ['Screen2'] });
  assert.equal(check(known, 'screen_transitions').status, 'passed');
});

test('画面遷移: 日本語名と引用符付き名のNavigate先を解決する', () => {
  const files = [
    file('Home.pa.yaml', screen('ホーム', "      OnSelect: =Navigate('画面 1'); Navigate(ホーム)\n")),
    file('S.pa.yaml', screen('画面 1'))
  ];
  assert.equal(check(runStaticTests({ files }), 'screen_transitions').status, 'passed');
});

test('データソース参照: 未指定はskipped、指定時は未登録をfailed、登録済みはpassed', () => {
  const files = [file('S.pa.yaml', screen('S', '      OnVisible: =Set(x, CN_AI_Bridge.GetTasks())\n'))];
  const unspecified = runStaticTests({ files });
  assert.equal(check(unspecified, 'data_sources').status, 'skipped');
  assert.deepEqual(check(unspecified, 'data_sources').referencedNames, ['CN_AI_Bridge']);
  const unknown = runStaticTests({ files, knownDataSources: ['Other'] });
  assert.equal(check(unknown, 'data_sources').status, 'failed');
  assert.equal(check(runStaticTests({ files, knownDataSources: ['CN_AI_Bridge'] }), 'data_sources').status, 'passed');
});

test('画面・コントロール名の重複定義をfailedにする', () => {
  const dup = `Screens:\n  S:\n    Children:\n      - Button1:\n          Control: Button@2.2.0\n      - Button1:\n          Control: Button@2.2.0\n`;
  assert.equal(check(runStaticTests({ files: [file('S.pa.yaml', dup)] }), 'duplicate_definitions').status, 'failed');
  const crossFile = runStaticTests({ files: [file('A.pa.yaml', screen('Same')), file('B.pa.yaml', screen('Same'))] });
  assert.equal(check(crossFile, 'duplicate_definitions').status, 'failed');
});

test('危険な削除: 重要ファイルの削除、削除対象と同名の画面への遷移が残る場合はfailed', () => {
  const critical = runStaticTests({ files: [{ relativePath: 'powerapps/x/Source/App.pa.yaml', delete: true }] });
  assert.equal(check(critical, 'dangerous_deletions').status, 'failed');
  const dangling = runStaticTests({
    files: [file('Home.pa.yaml', screen('Home', '      OnSelect: =Navigate(Screen2)\n')), { relativePath: 'Screen2.pa.yaml', delete: true }]
  });
  assert.equal(check(dangling, 'dangerous_deletions').status, 'failed');
  const safe = runStaticTests({ files: [{ relativePath: 'Unused.pa.yaml', delete: true }] });
  assert.equal(check(safe, 'dangerous_deletions').status, 'passed');
});

test('scanFormulaは問題の種類を区別する', () => {
  assert.deepEqual(scanFormula('=Max(1, 2)'), []);
  assert.equal(scanFormula('=Max(1, 2')[0].type, 'brackets');
  assert.equal(scanFormula('="abc')[0].type, 'quotes');
});

test('リポジトリ内の実Power Appsソース全体で、構文・括弧・引用符・重複定義がfailedにならない', () => {
  const dir = path.join(__dirname, '..', 'powerapps', 'CN_CompanyOS_ElectronicDailyReport', 'Source');
  const files = fs.readdirSync(dir).map((name) => file(name, fs.readFileSync(path.join(dir, name), 'utf8')));
  const result = runStaticTests({ files });
  assert.ok(result.formulasChecked > 100);
  for (const id of ['syntax', 'brackets', 'quotes', 'duplicate_definitions', 'screen_transitions', 'dangerous_deletions']) {
    assert.equal(check(result, id).status, 'passed', `${id}: ${JSON.stringify(check(result, id).findings || check(result, id).reason)}`);
  }
  assert.notEqual(result.status, 'passed', '未検証項目が残る限りpassedにしない');
});
