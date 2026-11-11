const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { parseAndAnalyzePowerAppsSource, inspectPowerAppsStructure } = require('../src/bridgeEnhancedFeatures');

test('structure reader handles canonical Children, nested controls and their formulas', () => {
  const text = `Screens:
  Home:
    Children:
      - Group:
          Control: GroupContainer
          Children:
            - Next:
                Control: Button
                Properties:
                  OnSelect: =Navigate(Detail)
`;
  const result = parseAndAnalyzePowerAppsSource(text);
  assert.deepEqual(result.controls.map(x => x.controlName), ['Group', 'Next']);
  assert.equal(result.powerFx.total, 1);
  assert.equal(result.navigations[0].target, 'Detail');
  const liveGit = parseAndAnalyzePowerAppsSource(fs.readFileSync('powerapps/CN_AI依頼台帳/Source/S1_Home.pa.yaml', 'utf8'));
  assert.equal(liveGit.screens[0].name, 'S1_Home');
  assert.ok(liveGit.controls.length > 10);
  assert.ok(liveGit.powerFx.total > liveGit.screens.length);
});

test('structure reader rejects malformed YAML, duplicate keys and cyclic children', () => {
  for (const text of ['Screens: [', 'Screens: {}\nScreens: {}', 'Screens:\n  Home: &self\n    Children:\n      - Loop: *self']) {
    assert.throws(() => parseAndAnalyzePowerAppsSource(text));
  }
});

test('legacy structure inspection rejects a different explicitly requested app', async () => {
  const result = await inspectPowerAppsStructure({ appId: 'requested', powerAppsStore: {
    getAppInfo: async () => ({ id: 'actual', screens: [{ name: 'Home' }], screenCount: 1 })
  } });
  assert.equal(result.verified, false);
  assert.equal(result.status, 'error');
  assert.equal(result.data.structure, null);
});
