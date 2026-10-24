const test = require('node:test');
const assert = require('node:assert/strict');
const { getConfig } = require('../src/config');
const { PowerAutomateRunner } = require('../src/powerAutomateRunner');
const { checkDependencies } = require('../src/bridgeCapabilities');

// Golden Path Contract: Power Platform 実行経路の安全性を CI で検出するための契約テスト。
// 実環境の値（トリガーURL・SAS）は使わず、明らかにダミーの値だけを用いる。

const DUMMY_TRIGGER_URL = 'https://example.invalid/workflows/FAKE/triggers/manual/paths/invoke?sig=DUMMY_SIGNATURE_FOR_TEST';

test('Contract: 不正な POWER_AUTOMATE_FLOWS は起動を落とさず空として扱う', () => {
  for (const raw of ['not-json', '[]', '"text"', '{"broken":']) {
    const cfg = getConfig({ POWER_AUTOMATE_FLOWS: raw });
    assert.deepEqual(cfg.powerAutomate.flows, {}, `raw=${raw}`);
  }
});

test('Contract: 未設定の flowKey は外部へ送信せず拒否する（安全側に失敗）', async () => {
  let called = false;
  const runner = new PowerAutomateRunner({
    flows: {},
    fetchImpl: async () => { called = true; }
  });
  await assert.rejects(() => runner.runFlow('missing', {}), /設定されていません/);
  assert.equal(called, false);
});

test('Contract: エラー応答にトリガーURL（SAS）を含めない', async () => {
  const runner = new PowerAutomateRunner({
    flows: { f1: DUMMY_TRIGGER_URL },
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'upstream failure', json: async () => ({}) })
  });
  await assert.rejects(
    () => runner.runFlow('f1', {}),
    (error) => {
      assert.equal(error.status, 502);
      assert.equal(String(error.message).includes('sig='), false);
      assert.equal(String(error.message).includes(DUMMY_TRIGGER_URL), false);
      return true;
    }
  );
});

test('Contract: 依存確認の出力にトリガーURLを含めない（optional 依存でも Secret を漏らさない）', async () => {
  const result = await checkDependencies({
    powerAppsStore: { getAppState: async () => ({ appId: 'a' }) },
    powerAppsGitStore: { healthCheck: async () => ({ ok: true, branch: 'main' }) },
    sharePointReader: { healthCheck: async () => ({ ok: true, status: 'ok' }) },
    powerAutomateRunner: new PowerAutomateRunner({ flows: { f1: DUMMY_TRIGGER_URL } })
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('sig=DUMMY_SIGNATURE_FOR_TEST'), false);
  assert.equal(serialized.includes('example.invalid/workflows'), false);
  assert.equal(result.data.dependencies.powerAutomate.status, 'ok');
});
